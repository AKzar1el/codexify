use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

// No start_url override: retain the owner's existing private URL at installation.
// Only these credential-free assets bypass bearer authentication.
fn asset(path: &str) -> Option<(&'static str, &'static [u8])> {
    Some(match path {
        "/manifest.webmanifest" => (
            "application/manifest+json",
            include_bytes!("pwa/manifest.webmanifest"),
        ),
        "/icons/app-180.png" => ("image/png", include_bytes!("pwa/app-180.png")),
        "/icons/app-192.png" => ("image/png", include_bytes!("pwa/app-192.png")),
        "/icons/app-512.png" => ("image/png", include_bytes!("pwa/app-512.png")),
        _ => return None,
    })
}

pub(super) fn is_asset(path: &str) -> bool {
    asset(path).is_some()
}

pub(super) async fn serve(uri: Uri) -> Response {
    match asset(uri.path()) {
        Some((mime, bytes)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
