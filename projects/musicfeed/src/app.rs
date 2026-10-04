// src/app.rs

use crate::AppState;
use crate::routes::{delete_item_ds, get_index_page, health_check, post_new_item_ds};
use crate::shutdown_signal;
use crate::telemetry::{MakeRequestUuid, request_span};
use axum::{
    Router,
    http::HeaderName,
    routing::{delete, get, post},
};
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::{
    request_id::{PropagateRequestIdLayer, SetRequestIdLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::info;

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

pub struct Application {
    listener: TcpListener,
    router: Router,
}

impl Application {
    pub async fn build(addr: &str, app_state: AppState) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        info!(address = %listener.local_addr()?, "listening");
        let router = build_router(app_state);

        Ok(Self { listener, router })
    }

    pub fn port(&self) -> std::io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub async fn run_until_stopped(self) -> std::io::Result<()> {
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(shutdown_signal())
            .await?;

        tracing::info!("shutdown complete");

        Ok(())
    }
}

pub fn build_router(state: AppState) -> Router {
    let trace_layer = TraceLayer::new_for_http().make_span_with(request_span);

    Router::new()
        .route("/", get(get_index_page))
        .route("/health_check", get(health_check))
        .route("/items", post(post_new_item_ds))
        .route("/items/{id}", delete(delete_item_ds))
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::new(
                    X_REQUEST_ID.clone(),
                    MakeRequestUuid,
                ))
                .layer(trace_layer)
                .layer(PropagateRequestIdLayer::new(X_REQUEST_ID)),
        )
        .nest_service("/static", ServeDir::new("static"))
        .with_state(state)
}
