use super::*;
use crate::markdown_chat::attachments::{AttachmentStore, MAX_ATTACHMENT_BYTES};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
static UPLOAD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
static THUMBNAIL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UploadQuery {
    request_id: String,
    name: String,
    last_modified_at_ms: Option<u64>,
    #[serde(default)]
    pasted: bool,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ContentQuery {
    #[serde(default)]
    download: bool,
    #[serde(default)]
    thumbnail: bool,
}

async fn thumbnail_content(
    chat_path: std::path::PathBuf,
    attachment: String,
    request_headers: &http::HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let permit = tokio::time::timeout(Duration::from_secs(15), THUMBNAIL_SLOTS.acquire())
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Image previews are busy".into(),
            )
        })?
        .map_err(internal_error)?;
    let preview = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        AttachmentStore::for_chat(&chat_path)?.thumbnail(&attachment)
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;
    let not_modified = request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == preview.etag)
        });
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let len = preview.file.metadata().map_err(internal_error)?.len();
        let body = Body::from_stream(tokio_util::io::ReaderStream::new(
            tokio::fs::File::from_std(preview.file).take(len),
        ));
        let mut response = body.into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
        response.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            header::HeaderValue::from_static("inline; filename=\"thumbnail.webp\""),
        );
        response
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("image/webp"),
    );
    headers.insert(header::ETAG, preview.etag.parse().map_err(internal_error)?);
    // Revalidate before reuse: changed/deleted originals and revoked sessions
    // must not keep serving an old preview. A 304 transfers no image bytes.
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-cache"),
    );
    headers.insert(
        header::VARY,
        header::HeaderValue::from_static("Cookie, Authorization"),
    );
    Ok(response)
}

pub(super) async fn upload(
    State(state): State<OwnerState>,
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    request: Request<Body>,
) -> ApiResult {
    let permit = tokio::time::timeout(Duration::from_secs(180), UPLOAD_SLOTS.acquire())
        .await
        .map_err(|_| {
            (
                StatusCode::REQUEST_TIMEOUT,
                "Attachment upload queue timed out".into(),
            )
        })?
        .map_err(internal_error)?;
    let located = selected(&state, &id)?;
    let media = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = tokio::time::timeout(
        Duration::from_secs(180),
        axum::body::to_bytes(request.into_body(), MAX_ATTACHMENT_BYTES),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::REQUEST_TIMEOUT,
            "Attachment upload timed out".into(),
        )
    })?
    .map_err(|_| {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Attachments are limited to 128 MiB per file".into(),
        )
    })?;
    let record = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        AttachmentStore::for_chat(&located.path)?.upload(
            &query.request_id,
            &query.name,
            &media,
            query.last_modified_at_ms,
            query.pasted,
            bytes.to_vec(),
        )
    })
    .await
    .map_err(internal_error)?
    .map_err(internal_error)?;
    Ok(Json(json!({"attachment":record})))
}

pub(super) async fn metadata(
    State(state): State<OwnerState>,
    Path((id, attachment)): Path<(String, String)>,
) -> ApiResult {
    let located = selected(&state, &id)?;
    let chat = state
        .chats
        .chat_at_path(located.path, true)
        .map_err(internal_error)?;
    let record = chat
        .uploaded_attachment(attachment)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({"attachment":record})))
}

fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let (first, last) = value.strip_prefix("bytes=")?.split_once('-')?;
    if first.is_empty() {
        let size = last.parse::<u64>().ok()?;
        if size == 0 || len == 0 {
            return None;
        }
        return Some((len.saturating_sub(size), len - 1));
    }
    let start = first.parse::<u64>().ok()?;
    let end = if last.is_empty() {
        len.checked_sub(1)?
    } else {
        last.parse::<u64>().ok()?.min(len.checked_sub(1)?)
    };
    (start <= end && start < len).then_some((start, end))
}

pub(super) async fn content(
    State(state): State<OwnerState>,
    Path((id, attachment)): Path<(String, String)>,
    Query(query): Query<ContentQuery>,
    request: Request<Body>,
) -> Result<Response, (StatusCode, String)> {
    let located = selected(&state, &id)?;
    let chat = state
        .chats
        .chat_at_path(located.path, true)
        .map_err(internal_error)?;
    let record = chat
        .uploaded_attachment(attachment)
        .await
        .map_err(internal_error)?;
    if !record.exists {
        return Err((
            StatusCode::NOT_FOUND,
            "Attachment payload no longer exists".into(),
        ));
    }
    if query.thumbnail {
        if query.download {
            return Err((
                StatusCode::BAD_REQUEST,
                "A thumbnail is not an original download".into(),
            ));
        }
        return thumbnail_content(chat.path().to_owned(), record.id, request.headers()).await;
    }
    let path = std::path::PathBuf::from(&record.path);
    let opened =
        tokio::task::spawn_blocking(move || crate::markdown_chat::attachments::open_payload(&path))
            .await
            .map_err(internal_error)?
            .map_err(internal_error)?;
    let mut file = tokio::fs::File::from_std(opened);
    let len = file.metadata().await.map_err(internal_error)?.len();
    let mut range = None;
    if let Some(raw) = request.headers().get(header::RANGE) {
        range = raw.to_str().ok().and_then(|v| byte_range(v, len));
        if range.is_none() {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{len}").parse().unwrap(),
            );
            return Ok(response);
        }
    }
    let (start, length) = range.map_or((0, len), |(start, end)| (start, end - start + 1));
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(internal_error)?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file.take(length)));
    let mut response = body.into_response();
    if let Some((start, end)) = range {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}").parse().unwrap(),
        );
    }
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        record
            .mime_type
            .parse()
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    headers.insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    let disposition = if !query.download
        && (record.mime_type.starts_with("image/") || record.mime_type.starts_with("video/"))
    {
        "inline"
    } else {
        "attachment"
    };
    let fallback = record
        .original_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " .-_()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let encoded = percent_encoding::utf8_percent_encode(
        &record.original_name,
        percent_encoding::NON_ALPHANUMERIC,
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
            .parse()
            .map_err(internal_error)?,
    );
    headers.insert(
        header::LAST_MODIFIED,
        chrono::DateTime::from_timestamp_millis(
            record.last_modified_at_ms.min(i64::MAX as u64) as i64
        )
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
        .parse()
        .map_err(internal_error)?,
    );
    Ok(response)
}

pub(super) fn is_content_path(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    parts.len() == 7
        && parts[1] == "api"
        && parts[2] == "chats"
        && parts[4] == "attachments"
        && parts[6] == "content"
}

pub(super) fn authorized_cookie(request: &Request<Body>, token: &str) -> bool {
    matches!(*request.method(), http::Method::GET | http::Method::HEAD)
        && is_content_path(request.uri().path())
        && request
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|cookies| {
                cookies
                    .split(';')
                    .any(|c| c.trim().strip_prefix("codexify-attachment=") == Some(token))
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn attachment_api_preserves_names_types_ranges_and_limits_cookie_authority() {
        crate::tls::ensure_crypto_provider();
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::config::default_config(root.path().join("project"));
        std::fs::create_dir_all(&config.work_dir).unwrap();
        config.markdown_chat.enabled = true;
        config.memory.dir = Some(root.path().join("state").display().to_string());
        let identity =
            crate::project_bindings::ConversationIdentity::from_openai_session("attachment-api")
                .unwrap();
        let chats = Arc::new(MarkdownChatStore::default());
        let chat = chats
            .chat(
                &config,
                Some(&identity),
                &crate::exec_sessions::SessionState::new(),
            )
            .unwrap();
        chat.ensure().await.unwrap();
        let state = OwnerState {
            project_bindings: Arc::new(crate::project_bindings::ProjectBindingStore::new(
                root.path().join("bindings"),
            )),
            creation_lock: Arc::default(),
            config: Arc::new(config.clone()),
            chats: chats.clone(),
            artifacts: Arc::new(ArtifactEgressStore::new_at(
                config.artifact_egress.clone(),
                root.path().join("artifacts"),
            )),
            continuations: Arc::new(
                ConversationContinuationStore::new(root.path().join("continuations.json")).unwrap(),
            ),
            automation: None,
            open_browser: Arc::new(|_| Ok(())),
            catalog_cache: Arc::default(),
            global: Arc::default(),
            token: "attachment-test-token".into(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("{base}/api/chats"))
            .bearer_auth("attachment-test-token")
            .send()
            .await
            .unwrap();
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let listing: Value = response.json().await.unwrap();
        let id = listing["chats"][0]["id"].as_str().unwrap();
        let upload=client.post(format!("{base}/api/chats/{id}/attachments?requestId=upload-pdf&name=r%C3%A9sum%C3%A9.pdf&lastModifiedAtMs=1000")).bearer_auth("attachment-test-token").header(header::CONTENT_TYPE,"application/pdf").body(b"%PDF-fixture".to_vec()).send().await.unwrap();
        assert_eq!(upload.status(), StatusCode::OK);
        let value: Value = upload.json().await.unwrap();
        let aid = value["attachment"]["id"].as_str().unwrap();
        assert_eq!(value["attachment"]["originalName"], "résumé.pdf");
        assert!(value["attachment"]["sourceCreatedAtMs"].is_null());
        assert!(chat.list_attachments().await.unwrap().is_empty());
        let url = format!("{base}/api/chats/{id}/attachments/{aid}/content");
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/api/chats"))
                .header(header::COOKIE, "codexify-attachment=attachment-test-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED,
            "download cookies cannot authorize other owner APIs"
        );
        let download = client
            .get(&url)
            .header(header::COOKIE, "codexify-attachment=attachment-test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(download.headers()[header::CONTENT_TYPE], "application/pdf");
        let disposition = download.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap();
        assert!(disposition.starts_with("attachment;"));
        let name = disposition.split("filename*=UTF-8''").nth(1).unwrap();
        assert_eq!(
            percent_encoding::percent_decode_str(name)
                .decode_utf8()
                .unwrap(),
            "résumé.pdf"
        );
        assert!(
            download.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .starts_with("sandbox;")
        );
        assert_eq!(download.bytes().await.unwrap().as_ref(), b"%PDF-fixture");
        let partial = client
            .get(&url)
            .bearer_auth("attachment-test-token")
            .header(header::RANGE, "bytes=0-3")
            .send()
            .await
            .unwrap();
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.headers()[header::CONTENT_RANGE], "bytes 0-3/12");
        assert_eq!(partial.bytes().await.unwrap().as_ref(), b"%PDF");
        let suffix = client
            .get(&url)
            .bearer_auth("attachment-test-token")
            .header(header::RANGE, "bytes=-4")
            .send()
            .await
            .unwrap();
        assert_eq!(suffix.bytes().await.unwrap().as_ref(), b"ture");
        assert_eq!(
            client
                .get(&url)
                .bearer_auth("attachment-test-token")
                .header(header::RANGE, "bytes=100-101")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        let sent=client.post(format!("{base}/api/chats/{id}/send")).bearer_auth("attachment-test-token").json(&json!({"request_id":"send-pdf","message":"Inspect this file","attachment_ids":[aid]})).send().await.unwrap();
        assert_eq!(sent.status(), StatusCode::OK);
        let page: Value = client
            .get(format!("{base}/api/chats/{id}"))
            .bearer_auth("attachment-test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            page["_meta"][CHAT_WIDGET_META]["messages"][0]["markdown"],
            "Inspect this file"
        );
        assert_eq!(
            page["_meta"][CHAT_WIDGET_META]["messages"][0]["attachments"][0]["id"],
            aid
        );
        let replay=client.post(format!("{base}/api/chats/{id}/send")).bearer_auth("attachment-test-token").json(&json!({"request_id":"send-pdf","message":"Inspect this file","attachment_ids":[aid]})).send().await.unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        assert_eq!(chat.unread_snapshot().await.unwrap().messages.len(), 1);
        // Previews are private, derived and reusable even for an older upload
        // that has never had a thumbnail. Original downloads remain untouched.
        let mut sample = 1_u32;
        let image =
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(1200, 800, |_, _| {
                sample = sample.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                image::Rgba([
                    (sample >> 24) as u8,
                    (sample >> 16) as u8,
                    (sample >> 8) as u8,
                    255,
                ])
            }));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();
        let uploaded: Value = client
            .post(format!(
                "{base}/api/chats/{id}/attachments?requestId=preview-image&name=photo.png"
            ))
            .bearer_auth("attachment-test-token")
            .header(header::CONTENT_TYPE, "image/png")
            .body(png.clone())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let image_id = uploaded["attachment"]["id"].as_str().unwrap();
        let original_url = format!("{base}/api/chats/{id}/attachments/{image_id}/content");
        let thumbnail_url = format!("{original_url}?thumbnail=true");
        assert_eq!(
            client.get(&thumbnail_url).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let preview = client
            .get(&thumbnail_url)
            .header(header::COOKIE, "codexify-attachment=attachment-test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(preview.status(), StatusCode::OK);
        assert_eq!(preview.headers()[header::CONTENT_TYPE], "image/webp");
        assert_eq!(
            preview.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );
        assert_eq!(preview.headers()[header::VARY], "Cookie, Authorization");
        assert!(
            preview.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .starts_with("sandbox;")
        );
        let etag = preview.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        let preview = preview.bytes().await.unwrap();
        assert!(preview.len() < png.len());
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (480, 320));
        for validator in [etag.clone(), format!("\"unrelated\", W/{etag}")] {
            let cached = client
                .get(&thumbnail_url)
                .bearer_auth("attachment-test-token")
                .header(header::IF_NONE_MATCH, validator)
                .send()
                .await
                .unwrap();
            assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
            assert_eq!(cached.headers()[header::CACHE_CONTROL], "private, no-cache");
            assert_eq!(cached.headers()[header::ETAG], etag);
            assert!(cached.bytes().await.unwrap().is_empty());
        }
        assert_eq!(
            client
                .get(&thumbnail_url)
                .header(header::IF_NONE_MATCH, &etag)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED,
            "cached previews still require authentication"
        );
        let original = client
            .get(&original_url)
            .bearer_auth("attachment-test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(original.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(original.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(original.bytes().await.unwrap().as_ref(), png);
        assert_eq!(
            client
                .get(format!("{thumbnail_url}&download=true"))
                .bearer_auth("attachment-test-token")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let source = uploaded["attachment"]["path"].as_str().unwrap();
        let mut changed = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            64,
            32,
            image::Rgba([0, 0, 255, 255]),
        ))
        .write_to(&mut changed, image::ImageFormat::Png)
        .unwrap();
        std::fs::write(source, changed.into_inner()).unwrap();
        let refreshed = client
            .get(&thumbnail_url)
            .bearer_auth("attachment-test-token")
            .header(header::IF_NONE_MATCH, &etag)
            .send()
            .await
            .unwrap();
        assert_eq!(refreshed.status(), StatusCode::OK);
        assert_ne!(refreshed.headers()[header::ETAG], etag);
        let decoded = image::load_from_memory(&refreshed.bytes().await.unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 32));
        std::fs::remove_file(source).unwrap();
        assert_eq!(
            client
                .get(&thumbnail_url)
                .bearer_auth("attachment-test-token")
                .header(header::IF_NONE_MATCH, &etag)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        server.abort();
    }
}
