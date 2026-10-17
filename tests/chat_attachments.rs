use codexify::markdown_chat::{MarkdownChatStore, attachments::AttachmentStore};
use std::io::Cursor;

fn png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        3,
        2,
        image::Rgba([10, 20, 30, 128]),
    ));
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

#[test]
fn uploads_are_persistent_private_unique_and_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let chat = root.path().join("a/CHAT.md");
    let store = AttachmentStore::for_chat(&chat).unwrap();
    let first = store
        .upload(
            "upload-1",
            "résumé.pdf",
            "application/pdf",
            Some(1000),
            false,
            b"%PDF-fixture".to_vec(),
        )
        .unwrap();
    let second = store
        .upload(
            "upload-2",
            "résumé.pdf",
            "application/pdf",
            Some(1000),
            false,
            b"%PDF-fixture".to_vec(),
        )
        .unwrap();
    assert_ne!(first.unique_name, second.unique_name);
    assert!(std::path::Path::new(&first.path).is_absolute());
    assert_eq!(first.original_name, "résumé.pdf");
    assert_eq!(first.mime_type, "application/pdf");
    assert_eq!(first.last_modified_at_ms, 1000);
    assert!(first.source_created_at_ms.is_none());
    assert_eq!(
        store
            .upload(
                "upload-1",
                "résumé.pdf",
                "application/pdf",
                Some(1000),
                false,
                b"%PDF-fixture".to_vec()
            )
            .unwrap()
            .id,
        first.id
    );
    assert!(
        store
            .upload(
                "upload-1",
                "changed.pdf",
                "application/pdf",
                Some(1000),
                false,
                b"changed".to_vec()
            )
            .is_err()
    );
    assert!(
        store
            .upload("upload-bad", "../escape", "", None, false, vec![])
            .is_err()
    );
    assert!(store.get("../../secret").is_err());
    assert_eq!(std::fs::read(&first.path).unwrap(), b"%PDF-fixture");
    let reloaded = AttachmentStore::for_chat(&chat).unwrap();
    assert_eq!(reloaded.get(&first.id).unwrap().size, 12);
    let other = AttachmentStore::for_chat(&root.path().join("b/CHAT.md")).unwrap();
    assert!(other.get(&first.id).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn pasted_images_are_pixel_lossless_png_and_file_uploads_keep_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
    let original = png();
    let stored = store
        .upload(
            "paste-png",
            "Pasted image.png",
            "image/png",
            None,
            true,
            original.clone(),
        )
        .unwrap();
    assert_eq!(std::fs::read(&stored.path).unwrap(), original);
    let source = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        3,
        2,
        image::Rgb([28, 90, 180]),
    ));
    let mut encoded = Cursor::new(Vec::new());
    source
        .write_to(&mut encoded, image::ImageFormat::Jpeg)
        .unwrap();
    let jpeg = encoded.into_inner();
    let pasted = store
        .upload(
            "paste-jpg",
            "clipboard.jpg",
            "image/jpeg",
            None,
            true,
            jpeg.clone(),
        )
        .unwrap();
    assert_eq!(pasted.mime_type, "image/png");
    assert!(pasted.unique_name.ends_with(".png"));
    assert_eq!(pasted.original_mime_type, "image/jpeg");
    let decoded = image::load_from_memory(&jpeg).unwrap();
    let converted = image::open(&pasted.path).unwrap();
    assert_eq!(decoded.to_rgba8(), converted.to_rgba8());
    let file = store
        .upload(
            "original-jpg",
            "photo.jpg",
            "image/jpeg",
            None,
            false,
            jpeg.clone(),
        )
        .unwrap();
    assert_eq!(std::fs::read(file.path).unwrap(), jpeg);
}

#[test]
fn pasted_animated_images_preserve_all_frames_as_png() {
    use image::AnimationDecoder;
    let root = tempfile::tempdir().unwrap();
    let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
    let frames = vec![
        image::Frame::from_parts(
            image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255])),
            0,
            0,
            image::Delay::from_numer_denom_ms(100, 1),
        ),
        image::Frame::from_parts(
            image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 255, 0, 255])),
            0,
            0,
            image::Delay::from_numer_denom_ms(200, 1),
        ),
    ];
    let mut gif = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut gif);
        encoder.encode_frames(frames.clone()).unwrap();
    }
    let pasted = store
        .upload(
            "paste-animation",
            "animation.gif",
            "image/gif",
            None,
            true,
            gif,
        )
        .unwrap();
    let png_bytes = std::fs::read(&pasted.path).unwrap();
    let info = png::Decoder::new(Cursor::new(&png_bytes))
        .read_info()
        .unwrap();
    assert_eq!(info.info().animation_control.unwrap().num_plays, 1);
    let png = image::codecs::png::PngDecoder::new(Cursor::new(std::fs::read(pasted.path).unwrap()))
        .unwrap();
    let decoded = png.apng().unwrap().into_frames().collect_frames().unwrap();
    assert_eq!(decoded.len(), 2);
    for (old, new) in frames.iter().zip(decoded) {
        assert_eq!(old.buffer(), new.buffer());
        assert_eq!(old.delay(), new.delay());
    }
}

#[test]
fn pasted_jpeg_orientation_is_preserved_without_resampling() {
    let root = tempfile::tempdir().unwrap();
    let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(3, 2, |x, y| {
        image::Rgb([(x * 60) as u8, (y * 80) as u8, 10])
    }));
    let mut jpeg = Cursor::new(Vec::new());
    image.write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
    let bytes = jpeg.into_inner();
    let exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = bytes[..2].to_vec();
    oriented.extend_from_slice(&[0xff, 0xe1]);
    oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend_from_slice(exif);
    oriented.extend_from_slice(&bytes[2..]);
    let uploaded = store
        .upload(
            "oriented-jpeg",
            "camera.jpg",
            "image/jpeg",
            None,
            true,
            oriented.clone(),
        )
        .unwrap();
    let mut expected = image::load_from_memory(&oriented).unwrap();
    expected.apply_orientation(image::metadata::Orientation::Rotate90);
    assert_eq!(
        image::open(uploaded.path).unwrap().to_rgba8(),
        expected.to_rgba8()
    );
}

#[tokio::test]
async fn submissions_expose_attachments_to_agents_and_render_clean_chat_messages() {
    let root = tempfile::tempdir().unwrap();
    let mut config = codexify::config::default_config(root.path().to_path_buf());
    config.markdown_chat.enabled = true;
    config.memory.dir = Some(root.path().join("metadata").display().to_string());
    let identity = codexify::project_bindings::ConversationIdentity::from_openai_session(
        "attachments-submission",
    )
    .unwrap();
    let session = codexify::exec_sessions::SessionState::new();
    let chat = MarkdownChatStore::default()
        .chat(&config, Some(&identity), &session)
        .unwrap();
    chat.ensure().await.unwrap();
    let store = AttachmentStore::for_chat(chat.path()).unwrap();
    let file = store
        .upload(
            "draft",
            "notes.txt",
            "text/plain",
            Some(1000),
            false,
            b"Some notes".to_vec(),
        )
        .unwrap();
    assert!(chat.list_attachments().await.unwrap().is_empty());
    assert!(chat.get_attachment(&file.id).await.is_err());
    let receipt = chat
        .append_user_with_attachments(
            "message-1".into(),
            "Analyze this file".into(),
            vec![file.id.clone()],
        )
        .await
        .unwrap();
    let delivered = chat.read(false).await.unwrap();
    for part in [
        "Analyze this file",
        "notes.txt",
        file.unique_name.as_str(),
        file.path.as_str(),
        "chat_list_attachments",
        "chat_search_attachments",
        "chat_get_attachment",
    ] {
        assert!(delivered.text.contains(part));
    }
    for internal in [
        "\"id\":",
        "messageId",
        "createdAtMs",
        "submittedAtMs",
        "toolCallCount",
        "originalSize",
        "pasted",
        "exists",
    ] {
        assert!(
            !delivered.text.contains(internal),
            "agent display leaked {internal}"
        );
    }
    let submitted = codexify::markdown_chat::attachments::date(receipt.created_at_ms.unwrap());
    assert!(delivered.text.starts_with(&format!("[{submitted}]\n")));
    // Presentation must not alter durable metadata, browser identities or retries.
    let raw = std::fs::read_to_string(chat.path()).unwrap();
    assert!(raw.contains("messageId"));
    assert!(raw.contains("message-1"));
    assert_eq!(chat.unread_snapshot().await.unwrap().messages.len(), 1);
    let page = chat.widget_page(None, None).await.unwrap();
    assert_eq!(page.messages[0].markdown, "Analyze this file");
    assert_eq!(page.messages[0].attachments[0].id, file.id);
    let listed = chat.list_attachments().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].submitted_at_ms, receipt.created_at_ms);
    let replay = chat
        .append_user_with_attachments(
            "message-1".into(),
            "Analyze this file".into(),
            vec![file.id.clone()],
        )
        .await
        .unwrap();
    assert_eq!(receipt.end, replay.end);
    assert!(
        chat.append_user_with_attachments(
            "message-1".into(),
            "changed".into(),
            vec![file.id.clone()]
        )
        .await
        .is_err()
    );
    assert!(
        chat.append_user_with_attachments(
            "message-2".into(),
            "other".into(),
            vec![file.id.clone()]
        )
        .await
        .is_err()
    );
    let second = store
        .upload("later", "photo.png", "image/png", None, false, png())
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    chat.append_user_with_attachments("message-2".into(), "".into(), vec![second.id.clone()])
        .await
        .unwrap();
    assert_eq!(chat.list_attachments().await.unwrap()[0].id, second.id);
    chat.read(true).await.unwrap();
    assert_eq!(
        chat.list_attachments().await.unwrap().len(),
        2,
        "reading chat does not remove submitted files"
    );
    let reopened = MarkdownChatStore::default()
        .chat(&config, Some(&identity), &session)
        .unwrap();
    assert_eq!(reopened.list_attachments().await.unwrap().len(), 2);
    std::fs::write(&file.path, b"Expanded notes and details").unwrap();
    assert_eq!(reopened.get_attachment(&file.id).await.unwrap().size, 26);
    std::fs::remove_file(&file.path).unwrap();
    let missing = reopened.get_attachment(&file.id).await.unwrap();
    assert!(!missing.exists);
    assert_eq!(missing.size, 26);
}
