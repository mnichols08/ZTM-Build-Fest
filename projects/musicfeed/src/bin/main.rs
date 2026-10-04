// src/main.rs

use musicfeed::AppState;
use musicfeed::Application;
use musicfeed::get_configuration;
use musicfeed::telemetry::{get_subscriber, init_subscriber};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // initialize tracing
    let subscriber = get_subscriber("musicfeed".into(), "info".into(), std::io::stdout);
    init_subscriber(subscriber);

    // construct the application state
    let app_state = AppState::default();

    // read the application settings
    let settings = get_configuration()?;
    let app_address = format!(
        "{}:{}",
        settings.application.host, settings.application.port
    );

    // build the application, passing in the address and app state
    let app = Application::build(&app_address, app_state).await?;

    // run the application
    app.run_until_stopped().await?;

    Ok(())
}
