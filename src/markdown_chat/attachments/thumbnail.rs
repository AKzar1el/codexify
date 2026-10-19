//! Derived previews live beside their originals and never replace upload bytes.
use super::*;
use std::fs::{File, Metadata};
use std::io::BufReader;
use std::sync::Mutex;

const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
// Coalesce requests for the same source without serializing all image previews.
static GENERATION_LOCKS: [Mutex<()>; 16] = [const { Mutex::new(()) }; 16];

pub(crate) struct Thumbnail {
    pub file: File,
    pub etag: String,
}

fn source_key(id: &str, metadata: &Metadata) -> Result<String, String> {
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{id}:{}:{modified}", metadata.len()).as_bytes())
    ))
}

fn cached(path: &Path) -> Result<Option<File>, String> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
        Ok(info)
            if !info.is_file()
                || info.file_type().is_symlink()
                || info.len() == 0
                || info.len() > MAX_THUMBNAIL_BYTES =>
        {
            Err("Invalid cached image thumbnail".into())
        }
        Ok(_) => open_payload(path).map(Some),
    }
}

impl AttachmentStore {
    pub(crate) fn thumbnail(&self, id: &str) -> Result<Thumbnail, String> {
        let record = self.get(id)?;
        if !record.exists || !record.mime_type.starts_with("image/") {
            return Err("This attachment has no image preview".into());
        }
        let original = open_payload(Path::new(&record.path))?;
        let metadata = original.metadata().map_err(|e| e.to_string())?;
        if metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
            return Err("Image exceeds the attachment size limit".into());
        }
        let key = source_key(id, &metadata)?;
        let _guard = GENERATION_LOCKS[usize::from(u8::from_str_radix(&key[..2], 16).unwrap()) % 16]
            .lock()
            .map_err(|_| "Thumbnail generation lock unavailable")?;
        let directory = self.root.join(".thumbnails");
        private_dir(&directory)?;
        let path = directory.join(format!("v1-{key}.webp"));
        let etag = format!("\"thumbnail-v1-{key}\"");
        if let Some(file) = cached(&path)? {
            return Ok(Thumbnail { file, etag });
        }

        let mut limits = image::Limits::default();
        limits.max_alloc = Some(MAX_IMAGE_ALLOCATION);
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        let mut reader = ImageReader::new(BufReader::new(
            original.try_clone().map_err(|e| e.to_string())?,
        ))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
        reader.limits(limits);
        let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
        let orientation = decoder.orientation().map_err(|e| e.to_string())?;
        let profile = decoder.icc_profile().map_err(|e| e.to_string())?;
        let mut image = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
        image.apply_orientation(orientation);
        let preview = image
            .thumbnail(image.width().min(480), image.height().min(320))
            .to_rgba8();
        let mut output = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(output.as_file_mut());
        if let Some(profile) = profile {
            encoder
                .set_icc_profile(profile)
                .map_err(|e| e.to_string())?;
        }
        encoder
            .write_image(
                preview.as_raw(),
                preview.width(),
                preview.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
        if output
            .as_file()
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            > MAX_THUMBNAIL_BYTES
        {
            return Err("Thumbnail exceeds the preview size limit".into());
        }
        if source_key(id, &original.metadata().map_err(|e| e.to_string())?)? != key {
            return Err("Attachment changed while generating its preview".into());
        }
        output.as_file().sync_all().map_err(|e| e.to_string())?;
        if let Err(error) = output.persist_noclobber(&path)
            && error.error.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(error.error.to_string());
        }
        Ok(Thumbnail {
            file: cached(&path)?.ok_or("Thumbnail cache file is unavailable")?,
            etag,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba(color),
        ))
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
        bytes.into_inner()
    }
    fn bytes(mut thumbnail: Thumbnail) -> Vec<u8> {
        let mut bytes = Vec::new();
        thumbnail.file.read_to_end(&mut bytes).unwrap();
        bytes
    }
    fn cache_files(store: &AttachmentStore) -> Vec<PathBuf> {
        std::fs::read_dir(store.root.join(".thumbnails"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect()
    }

    #[test]
    fn previews_are_bounded_private_cached_across_reload_and_keep_originals_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let chat = root.path().join("CHAT.md");
        let store = AttachmentStore::for_chat(&chat).unwrap();
        let original = png(2400, 1600, [10, 80, 180, 128]);
        let record = store
            .upload(
                "thumbnail",
                "large.png",
                "image/png",
                None,
                false,
                original.clone(),
            )
            .unwrap();
        let first = store.thumbnail(&record.id).unwrap();
        let etag = first.etag.clone();
        let data = bytes(first);
        let decoded = image::load_from_memory(&data).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (480, 320));
        assert_eq!(decoded.to_rgba8().get_pixel(0, 0).0, [10, 80, 180, 128]);
        assert_eq!(std::fs::read(&record.path).unwrap(), original);
        let cache = cache_files(&store);
        assert_eq!(cache.len(), 1);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&cache[0])
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1))
            .unwrap();
        let reopened = AttachmentStore::for_chat(&chat).unwrap();
        let second = reopened.thumbnail(&record.id).unwrap();
        assert_eq!(second.etag, etag);
        assert_eq!(bytes(second), data);
        assert_eq!(
            std::fs::metadata(&cache[0]).unwrap().modified().unwrap(),
            UNIX_EPOCH + Duration::from_secs(1)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&cache[0]).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let changed = png(400, 800, [180, 50, 20, 255]);
        std::fs::write(&record.path, &changed).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&record.path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(2))
            .unwrap();
        let next = store.thumbnail(&record.id).unwrap();
        assert_ne!(next.etag, etag);
        let decoded = image::load_from_memory(&bytes(next)).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (160, 320));
        assert_eq!(std::fs::read(&record.path).unwrap(), changed);
        std::fs::remove_file(&record.path).unwrap();
        assert!(
            store.thumbnail(&record.id).is_err(),
            "deleting the original revokes its cached preview"
        );
    }

    #[test]
    fn camera_orientation_and_the_first_animation_frame_are_preserved_without_upscaling() {
        let root = tempfile::tempdir().unwrap();
        let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(3, 2, |x, y| {
            image::Rgb([(x * 60) as u8, (y * 80) as u8, 10])
        }));
        let mut jpeg = Cursor::new(Vec::new());
        image.write_to(&mut jpeg, ImageFormat::Jpeg).unwrap();
        let jpeg = jpeg.into_inner();
        let exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = jpeg[..2].to_vec();
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let record = store
            .upload(
                "camera",
                "camera.jpg",
                "image/jpeg",
                None,
                false,
                oriented.clone(),
            )
            .unwrap();
        let mut expected = image::load_from_memory(&oriented).unwrap();
        expected.apply_orientation(image::metadata::Orientation::Rotate90);
        let decoded =
            image::load_from_memory(&bytes(store.thumbnail(&record.id).unwrap())).unwrap();
        assert_eq!(decoded.to_rgba8(), expected.to_rgba8());
        assert_eq!((decoded.width(), decoded.height()), (2, 3));
        assert_eq!(std::fs::read(record.path).unwrap(), oriented);
        let mut gif = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut gif);
            encoder
                .encode_frames([[255, 0, 0, 255], [0, 255, 0, 255]].map(|color| {
                    image::Frame::new(image::RgbaImage::from_pixel(4, 2, image::Rgba(color)))
                }))
                .unwrap();
        }
        let record = store
            .upload(
                "animation",
                "animation.gif",
                "image/gif",
                None,
                false,
                gif.clone(),
            )
            .unwrap();
        let decoded =
            image::load_from_memory(&bytes(store.thumbnail(&record.id).unwrap())).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 2));
        assert_eq!(decoded.to_rgba8().get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(std::fs::read(record.path).unwrap(), gif);
    }

    #[test]
    fn concurrent_requests_share_the_cache_and_invalid_or_oversized_images_fail_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
        let record = store
            .upload(
                "parallel",
                "image.png",
                "image/png",
                None,
                false,
                png(600, 400, [20, 40, 60, 255]),
            )
            .unwrap();
        std::thread::scope(|scope| {
            let handles = (0..8)
                .map(|_| scope.spawn(|| bytes(store.thumbnail(&record.id).unwrap())))
                .collect::<Vec<_>>();
            let results = handles
                .into_iter()
                .map(|t| t.join().unwrap())
                .collect::<Vec<_>>();
            assert!(results.windows(2).all(|w| w[0] == w[1]));
        });
        assert_eq!(cache_files(&store).len(), 1);
        let invalid = store
            .upload(
                "invalid",
                "bad.png",
                "image/png",
                None,
                false,
                b"not an image".to_vec(),
            )
            .unwrap();
        assert!(store.thumbnail(&invalid.id).is_err());
        let wide = store
            .upload(
                "wide",
                "wide.png",
                "image/png",
                None,
                false,
                png(32769, 1, [0, 0, 0, 255]),
            )
            .unwrap();
        assert!(store.thumbnail(&wide.id).is_err());
        assert!(store.thumbnail("../../outside").is_err());
        let other = AttachmentStore::for_chat(&root.path().join("other/CHAT.md")).unwrap();
        assert!(other.thumbnail(&record.id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn thumbnail_cache_rejects_symlinked_directories_and_files() {
        let root = tempfile::tempdir().unwrap();
        let store = AttachmentStore::for_chat(&root.path().join("CHAT.md")).unwrap();
        let record = store
            .upload(
                "links",
                "image.png",
                "image/png",
                None,
                false,
                png(3, 2, [0, 0, 0, 255]),
            )
            .unwrap();
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, store.root.join(".thumbnails")).unwrap();
        assert!(store.thumbnail(&record.id).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_file(store.root.join(".thumbnails")).unwrap();
        store.thumbnail(&record.id).unwrap();
        let path = cache_files(&store).pop().unwrap();
        std::fs::remove_file(&path).unwrap();
        let secret = outside.join("secret");
        std::fs::write(&secret, b"private").unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert!(store.thumbnail(&record.id).is_err());
        assert_eq!(std::fs::read(secret).unwrap(), b"private");
    }
}
