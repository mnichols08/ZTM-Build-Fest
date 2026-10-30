// src/utils.rs

use tokio::signal;

/// Collapse a rendered HTML fragment onto a single line.
///
/// Datastar's SSE encoder prefixes *every line* of `data: elements` with its own
/// `data: elements `, so a pretty-printed fragment reaches the browser as many
/// separate patch instructions instead of one append. The server-rendered page is
/// unaffected — only the live SSE path breaks — which makes this easy to miss.
///
/// Compacting at render time keeps the templates readable, which matters because
/// they are the single source of truth for the markup on both paths.
///
/// Every run of whitespace — inside tags and between them — collapses to a single
/// space. That is safe for the markup we emit but is *not* a general-purpose HTML
/// minifier: it does not track quote state inside a tag, and it does not preserve
/// whitespace inside `<pre>`/`<textarea>`/`<script>`. If those ever matter, verify
/// with the `sse_patch_is_a_single_data_elements_field` test.
pub fn compact_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pending_space = false;

    for ch in html.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }

    out.trim().to_string()
}

pub async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

pub fn error_chain_fmt(
    e: &impl std::error::Error,
    f: &mut std::fmt::Formatter<'_>,
) -> std::fmt::Result {
    writeln!(f, "{}\n", e)?;
    let mut current = e.source();
    while let Some(cause) = current {
        writeln!(f, "Caused by:\n\t{}", cause)?;
        current = cause.source();
    }
    Ok(())
}
