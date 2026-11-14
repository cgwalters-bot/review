use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;

#[tokio::test]
async fn one_shot_exits_with_json_without_a_token_or_server() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("board.json");
    std::fs::write(
        &config,
        json!({
            "operator":"operator", "bot":"robot", "dispatchRepo":"example/runner",
            "dispatchWorkflow":"dispatch.yml", "dispatchRef":"main",
            "board":{"owner":"example", "project":1}, "wip":8,
            "usage":{"repository":"example/ops", "issue":1},
            "pools":{"test":{"target":0.9,"burst":3}}, "planPools":["test"]
        })
        .to_string(),
    )
    .unwrap();
    // A missing token fails before sending requests. No built app or running
    // service is needed; an accidental fall-through to serving would time out.
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(env!("CARGO_BIN_EXE_control-app"))
            .current_dir(dir.path())
            .arg("--board-once")
            .arg(&config)
            .arg("--github-token-file")
            .arg(dir.path().join("missing-token"))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], "review-service/v1");
    assert_eq!(value["generation"], 1);
    assert_eq!(value["decision"]["complete"], false);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("board preview incomplete")
    );
    assert!(value["decisionRefresh"]["requests"].as_u64().unwrap() <= 128);
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "the preview must not persist state or create output files itself"
    );
}
