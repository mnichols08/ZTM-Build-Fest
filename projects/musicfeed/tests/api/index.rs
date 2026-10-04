// tests/api/index.rs

use crate::helpers::spawn_app;

#[tokio::test]
async fn index_page_returns_200() {
    // Arrange
    let app = spawn_app().await;
    let client = reqwest::Client::new();

    // Act
    let response = client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert
    assert!(response.status().is_success());
}
