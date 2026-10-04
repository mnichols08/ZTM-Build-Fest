// src/routes/items.rs

use crate::utils::error_chain_fmt;
use crate::{AppState, Item};
use axum::extract::Path;
use axum::response::{
    IntoResponse, Response,
    sse::{Event, Sse},
};
use axum::{extract::State, http::StatusCode};
use axum_macros::debug_handler;
use datastar::{axum::ReadSignals, prelude::*};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tera::Context;

#[derive(thiserror::Error)]
pub enum ItemsError {
    #[error("shared state lock poisoned")]
    StateLock,
    #[error("item not found")]
    NotFound,
    #[error("template rendering failed")]
    Template(#[from] tera::Error),
}

impl std::fmt::Debug for ItemsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        error_chain_fmt(self, f)
    }
}

impl IntoResponse for ItemsError {
    fn into_response(self) -> Response {
        tracing::error!(error = ?self, "request failed");
        let status = match self {
            ItemsError::NotFound => StatusCode::NOT_FOUND,
            ItemsError::StateLock | ItemsError::Template(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, "Something went wrong.").into_response()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct NewItem {
    item: String,
}

/// Render a single item fragment via Tera.
///
/// This is the single source of truth for the `<li>` markup: `index.html` includes
/// the same partial for the server-rendered page, so the initial render and the SSE
/// patch can never disagree. Routing both through Tera also means user input is
/// escaped by the same rules on both paths - do not hand-build this HTML.
fn render_item(state: &AppState, id: u64, text: &str) -> Result<String, ItemsError> {
    let mut context = Context::new();
    context.insert(
        "item",
        &Item {
            id,
            text: text.to_string(),
        },
    );
    Ok(state.templates.render("item.html", &context)?)
}

#[debug_handler]
pub async fn post_new_item_ds(
    State(state): State<AppState>,
    ReadSignals(new_item): ReadSignals<NewItem>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ItemsError> {
    let id = {
        let mut next = state.next_id.lock().map_err(|_| ItemsError::StateLock)?;
        let id = *next;
        *next += 1;
        id
    };

    let mut items = state.items.lock().map_err(|_| ItemsError::StateLock)?;
    items.push(Item {
        id,
        text: new_item.item.clone(),
    });

    let patch = PatchElements::new(render_item(&state, id, &new_item.item)?)
        .selector("#item-list")
        .mode(ElementPatchMode::Append)
        .write_as_axum_sse_event();

    let clear = PatchSignals::new(r#"{"item":""}"#).write_as_axum_sse_event();

    let sse_event = Sse::new(tokio_stream::iter(vec![Ok(patch), Ok(clear)]));

    Ok(sse_event)
}

#[debug_handler]
pub async fn delete_item_ds(
    State(state): State<AppState>,
    Path(id): Path<usize>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ItemsError> {
    let mut items = state.items.lock().map_err(|_| ItemsError::StateLock)?;

    let Some(pos) = items.iter().position(|item| item.id == id as u64) else {
        return Err(ItemsError::NotFound);
    };

    items.remove(pos);

    let patch = PatchElements::new_remove(format!("#item-{id}")).write_as_axum_sse_event();

    let sse_event = Sse::new(tokio_stream::iter(vec![Ok(patch)]));

    Ok(sse_event)
}
