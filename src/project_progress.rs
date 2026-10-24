//! Request-scoped workspace progress. Other project operations remain silent.

use std::future::Future;
use std::io::{self, Read, Write};
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Progress {
    pub message: String,
    pub detail: String,
    pub percent: Option<u8>,
}

impl Progress {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            detail: String::new(),
            percent: None,
        }
    }
}

tokio::task_local! {
    static CURRENT: watch::Sender<Progress>;
}

pub(crate) async fn scope<F: Future>(sender: watch::Sender<Progress>, operation: F) -> F::Output {
    CURRENT.scope(sender, operation).await
}

pub(crate) fn active() -> bool {
    CURRENT.try_with(|_| ()).is_ok()
}

pub(crate) fn phase(message: impl Into<String>) {
    let _ = CURRENT.try_with(|sender| sender.send_replace(Progress::new(message)));
}

pub(crate) fn detail(text: impl Into<String>, percent: Option<u8>) {
    let _ = CURRENT.try_with(|sender| {
        sender.send_modify(|progress| {
            progress.detail = text.into();
            progress.percent = percent.map(|value| value.min(100));
        })
    });
}

fn git_progress(line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    let line = line.trim().strip_prefix("remote: ").unwrap_or(line.trim());
    let Some((stage, values)) = line.split_once(':') else {
        return;
    };
    if !matches!(
        stage,
        "Receiving objects"
            | "Resolving deltas"
            | "Updating files"
            | "Checking out files"
            | "Enumerating objects"
            | "Counting objects"
            | "Compressing objects"
    ) {
        return;
    }
    let percent = values
        .trim()
        .split_once('%')
        .and_then(|(number, _)| number.parse::<u8>().ok())
        .filter(|value| *value <= 100);
    detail(line.chars().take(512).collect::<String>(), percent);
}

async fn read_progress(mut reader: impl AsyncRead + Unpin) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut pending = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..count]);
        for byte in &buffer[..count] {
            if matches!(*byte, b'\r' | b'\n') {
                git_progress(&pending);
                pending.clear();
            } else if pending.len() < 4096 {
                pending.push(*byte);
            }
        }
    }
    git_progress(&pending);
    Ok(output)
}

/// Drain both pipes while observing Git's carriage-return progress records.
/// The caller still owns the existing timeout and kill-on-drop policy.
pub(crate) async fn command_output(command: &mut Command) -> io::Result<Output> {
    if !active() {
        return command.output().await;
    }
    command
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (exit, stdout, stderr) = tokio::join!(
        child.wait(),
        async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await?;
            Ok::<_, io::Error>(bytes)
        },
        read_progress(stderr),
    );
    Ok(Output {
        status: exit?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

/// Keep large copies off the async runtime, carrying the request's progress scope.
pub(crate) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let Ok(sender) = CURRENT.try_with(Clone::clone) else {
        return Ok(operation());
    };
    tokio::task::spawn_blocking(move || CURRENT.sync_scope(sender, operation))
        .await
        .map_err(|error| format!("Workspace file copying failed: {error}"))
}

pub(crate) fn copy(input: &mut impl Read, output: &mut impl Write, size: u64) -> io::Result<u64> {
    if !active() {
        return io::copy(input, output);
    }
    let mut buffer = vec![0; 256 * 1024];
    let mut copied = 0_u64;
    let mut last_update = Instant::now();
    loop {
        let count = match input.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        copied = copied.saturating_add(count as u64);
        if last_update.elapsed() >= Duration::from_millis(100) {
            copy_progress(copied, size);
            last_update = Instant::now();
        }
    }
    copy_progress(copied, size);
    Ok(copied)
}

fn copy_progress(copied: u64, size: u64) {
    let percent = (size > 0).then(|| ((copied as u128 * 100 / size as u128).min(100)) as u8);
    detail(format!("{copied} of {size} bytes copied"), percent);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn git_progress_uses_real_percentages_and_ignores_other_output() {
        let (sender, receiver) = watch::channel(Progress::new("Cloning repository"));
        scope(sender, async {
            let bytes = b"Receiving objects:  42% (42/100)\rResolving deltas:  17% (17/100)\nsecret or arbitrary command output\n";
            assert_eq!(read_progress(bytes.as_slice()).await.unwrap(), bytes);
            let progress = receiver.borrow();
            assert_eq!(progress.message, "Cloning repository");
            assert_eq!(progress.percent, Some(17));
            assert_eq!(progress.detail, "Resolving deltas:  17% (17/100)");
        }).await;
    }

    #[tokio::test]
    async fn copy_progress_preserves_bytes_and_crosses_the_blocking_boundary() {
        let (sender, receiver) = watch::channel(Progress::new("Copying file"));
        scope(sender, async {
            let output = blocking(|| {
                let source = vec![7; 600_000];
                let mut output = Vec::new();
                assert_eq!(
                    copy(&mut source.as_slice(), &mut output, source.len() as u64).unwrap(),
                    600_000
                );
                output
            })
            .await
            .unwrap();
            assert_eq!(output, vec![7; 600_000]);
            assert_eq!(receiver.borrow().percent, Some(100));
            phase("Saving workspace");
            assert_eq!(receiver.borrow().percent, None);
        })
        .await;
        assert!(!active());
    }
}
