use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

pub fn monitor_args(input_id: &str, output_id: &str) -> Vec<String> {
    vec!["--monitor-input".into(), input_id.into(), output_id.into()]
}

pub fn spawn(bridge: &Path, input_id: &str, output_id: &str) -> Result<Child, &'static str> {
    if !bridge.is_file()
        || input_id.trim().is_empty()
        || output_id.trim().is_empty()
        || input_id == output_id
    {
        return Err("OPERATOR_MONITOR_INVALID");
    }
    let mut command = Command::new(bridge);
    command
        .args(monitor_args(input_id, output_id))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "OPERATOR_MONITOR_START_FAILED")?;
    let stdout = child.stdout.take().ok_or("OPERATOR_MONITOR_START_FAILED")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line.trim() == "MONITOR_READY")
            .unwrap_or(false);
        let _ = sender.send(result);
    });
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(true) => Ok(child),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Err("OPERATOR_MONITOR_START_FAILED")
        }
    }
}

pub fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_arguments_are_narrow_and_missing_bridge_fails_before_spawn() {
        assert_eq!(
            monitor_args("physical", "cable"),
            ["--monitor-input", "physical", "cable"]
        );
        assert_eq!(
            spawn(Path::new("missing-audio-bridge.exe"), "physical", "cable").unwrap_err(),
            "OPERATOR_MONITOR_INVALID"
        );
    }
}
