// tests/api/items.rs
use crate::helpers::spawn_app;

#[tokio::test]
async fn post_new_item_returns_append_patch_and_clears_signal() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let response = app
        .api_client
        .post(format!("{}/items", &app.address))
        .json(&serde_json::json!({"item": "fish"}))
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("event: datastar-patch-elements"));
    assert!(body.contains("data: selector #item-list"));
    assert!(body.contains("data: mode append"));
    // items now carry a stable id and their own delete button
    assert!(body.contains(r#"data: elements <li id="item-0">fish"#));
    assert!(body.contains(r#"data-on:click="@delete('/items/0')"#));
    assert!(body.contains("event: datastar-patch-signals"));
}

#[tokio::test]
async fn posted_item_appears_in_index_list() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let _response = app
        .api_client
        .post(format!("{}/items", &app.address))
        .json(&serde_json::json!({"item": "fish"}))
        .send()
        .await
        .expect("Failed to execute request.");

    let body = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();

    // Assert — the shared item partial supplies both the id and the text
    assert!(body.contains(r#"<li id="item-0">"#));
    assert!(body.contains("fish"));
}

#[tokio::test]
async fn posted_item_can_be_deleted() {
    // Arrange
    let app = spawn_app().await;
    app.api_client
        .post(format!("{}/items", &app.address))
        .json(&serde_json::json!({"item": "fish"}))
        .send()
        .await
        .expect("Failed to execute request.");

    // Act
    let response = app
        .api_client
        .delete(format!("{}/items/0", &app.address))
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — the wire says: remove #item-0, nothing else
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();
    assert!(body.contains("event: datastar-patch-elements"));
    assert!(body.contains("data: selector #item-0"));
    assert!(body.contains("data: mode remove"));

    // And the index agrees the list is empty again
    let body = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(!body.contains("<li id"));
}

#[tokio::test]
async fn deleting_a_missing_item_returns_404() {
    // Arrange
    let app = spawn_app().await;

    // Act
    let response = app
        .api_client
        .delete(format!("{}/items/99", &app.address))
        .send()
        .await
        .expect("Failed to execute request.");

    // Assert — a stale id is a client error, not a server failure
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn item_text_is_escaped_in_the_sse_patch() {
    // Arrange
    let app = spawn_app().await;
    let payload = r#"<img src=x onerror=alert(1)>"#;

    // Act
    let response = app
        .api_client
        .post(format!("{}/items", &app.address))
        .json(&serde_json::json!({ "item": payload }))
        .send()
        .await
        .expect("Failed to execute request.");
    let sse_body = response.text().await.unwrap();

    // Assert — the patch carries escaped text, never raw markup. The SSE path and the
    // server-rendered page must agree, or a stored payload runs for whoever loads the page.
    assert!(
        !sse_body.contains(payload),
        "raw payload leaked into the SSE patch: {sse_body}"
    );
    assert!(sse_body.contains("&lt;img src=x onerror=alert(1)&gt;"));

    // And the server-rendered page escapes it identically.
    let page = app
        .api_client
        .get(&app.address)
        .send()
        .await
        .expect("Failed to execute request")
        .text()
        .await
        .unwrap();
    assert!(
        !page.contains(payload),
        "raw payload leaked into the page: {page}"
    );
    assert!(page.contains("&lt;img src=x onerror=alert(1)&gt;"));
}
