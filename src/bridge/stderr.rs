//! Forward upstream diagnostics, omitting only the SDK's routine ping receipt.

use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const PING_LINE: &[u8] = b"Processing request of type PingRequest";

pub(super) async fn forward<R, W>(mut reader: R, mut writer: W) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = [0; 8192];
    let mut candidate = Vec::with_capacity(PING_LINE.len() + 1);
    let mut output = Vec::with_capacity(buffer.len() + PING_LINE.len() + 1);
    let mut passthrough = false;
    loop {
        let length = reader.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        output.clear();
        for &byte in &buffer[..length] {
            if passthrough {
                output.push(byte);
                passthrough = byte != b'\n';
                continue;
            }
            candidate.push(byte);
            if byte == b'\n' {
                let line = candidate[..candidate.len() - 1]
                    .strip_suffix(b"\r")
                    .unwrap_or(&candidate[..candidate.len() - 1]);
                if line != PING_LINE {
                    output.extend_from_slice(&candidate);
                }
                candidate.clear();
            } else if !PING_LINE.starts_with(&candidate)
                && candidate.strip_suffix(b"\r") != Some(PING_LINE)
            {
                output.extend_from_slice(&candidate);
                candidate.clear();
                passthrough = true;
            }
        }
        if !output.is_empty() {
            writer.write_all(&output).await?;
            writer.flush().await?;
        }
    }
    let final_line = candidate.strip_suffix(b"\r").unwrap_or(&candidate);
    if final_line != PING_LINE {
        writer.write_all(&candidate).await?;
    }
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn suppresses_only_the_exact_ping_receipt_with_lf_crlf_or_eof() {
        let input = b"startup\nProcessing request of type PingRequest\nProcessing request of type CallToolRequest\r\nProcessing request of type PingRequest\r\nERROR: Processing request of type PingRequest\nProcessing request of type PingRequest failed\nProcessing request of type PingRequest";
        let mut output = Vec::new();
        forward(&input[..], &mut output).await.unwrap();
        assert_eq!(output,b"startup\nProcessing request of type CallToolRequest\r\nERROR: Processing request of type PingRequest\nProcessing request of type PingRequest failed\n");
    }

    #[tokio::test]
    async fn preserves_long_lines_invalid_utf8_and_partial_ping_prefixes() {
        let mut input = vec![b'x'; 100_000];
        input.extend_from_slice(b"\xff\x00\nProcessing request of type Pin");
        let mut output = Vec::new();
        forward(&input[..], &mut output).await.unwrap();
        assert_eq!(output, input);
    }

    #[tokio::test]
    async fn split_reads_do_not_leak_ping_fragments_or_delay_unrelated_errors() {
        let (mut sender, receiver) = tokio::io::duplex(128);
        let (sink, mut output) = tokio::io::duplex(128);
        let task = tokio::spawn(forward(receiver, sink));
        sender
            .write_all(b"Processing request of type Ping")
            .await
            .unwrap();
        sender.write_all(b"Request\r").await.unwrap();
        sender
            .write_all(b"\nwarning without a newline")
            .await
            .unwrap();
        let mut warning = vec![0; 25];
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            output.read_exact(&mut warning),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(warning, b"warning without a newline");
        sender.shutdown().await.unwrap();
        task.await.unwrap().unwrap();
        let mut remainder = Vec::new();
        output.read_to_end(&mut remainder).await.unwrap();
        assert!(remainder.is_empty());
    }
}
