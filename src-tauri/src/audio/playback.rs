//! Bounded PCM playback through the existing, application-owned AudioBridge.
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub struct AudioOutputDevice {
    pub id: String,
    pub name: String,
}

pub fn list_outputs(executable: &std::path::Path) -> Result<Vec<AudioOutputDevice>, &'static str> {
    use std::io::Read;
    if !executable.is_file() {
        return Err("SESSION_SIDECAR_MISSING");
    }
    let mut command = Command::new(executable);
    command
        .arg("--list-output-devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|_| "OUTPUT_ENUMERATION_FAILED")?;
    let output = child.stdout.take().ok_or("OUTPUT_ENUMERATION_FAILED")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    let success = loop {
        if started.elapsed() > Duration::from_secs(5) {
            break false;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => break false,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    if !success {
        let _ = child.kill();
    }
    let _ = child.wait();
    let bytes = reader
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or("OUTPUT_ENUMERATION_FAILED")?;
    if !success || bytes.len() > 65536 {
        return Err("OUTPUT_ENUMERATION_FAILED");
    }
    serde_json::from_slice(&bytes).map_err(|_| "OUTPUT_ENUMERATION_FAILED")
}

#[derive(Debug, Clone)]
pub struct BridgePlayback {
    pub executable: PathBuf,
    pub endpoint_id: String,
}

impl BridgePlayback {
    pub fn play(
        &self,
        pcm: &[u8],
        sample_rate: u32,
        cancelled: impl Fn() -> bool,
    ) -> Result<(), &'static str> {
        if cancelled() {
            return Err("PLAYBACK_CANCELLED");
        }
        if pcm.is_empty()
            || !pcm.len().is_multiple_of(2)
            || pcm.len() > 16 * 1024 * 1024
            || !(8000..=48000).contains(&sample_rate)
            || self.endpoint_id.trim().is_empty()
        {
            return Err("PLAYBACK_FORMAT_INVALID");
        }
        if !self.executable.is_file() {
            return Err("SESSION_SIDECAR_MISSING");
        }
        let mut command = Command::new(&self.executable);
        command
            .arg("--play-pcm")
            .arg(&self.endpoint_id)
            .arg(sample_rate.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().map_err(|_| "PLAYBACK_START_FAILED")?;
        let completion = child
            .stdout
            .take()
            .map(|pipe| crate::prerequisites::read_pipe_bounded(pipe, 128, None));
        let Some(mut input) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("PLAYBACK_START_FAILED");
        };
        let payload = pcm.to_vec();
        let writer = std::thread::spawn(move || input.write_all(&payload));
        let started = Instant::now();
        let budget = Duration::from_secs_f64(pcm.len() as f64 / (sample_rate as f64 * 2.0) + 15.0);
        let result = loop {
            if cancelled() {
                break Err("PLAYBACK_CANCELLED");
            }
            if started.elapsed() > budget {
                break Err("PLAYBACK_TIMEOUT");
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(())
                    } else {
                        Err("PLAYBACK_FAILED")
                    };
                }
                Err(_) => break Err("PLAYBACK_FAILED"),
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            }
        };
        if result.is_err() {
            let _ = child.kill();
        }
        let _ = child.wait();
        let written = writer.join().ok().and_then(Result::ok).is_some();
        if cancelled() {
            return Err("PLAYBACK_CANCELLED");
        }
        result.and(if written {
            completion
                .and_then(|reader| reader.recv_timeout(Duration::from_secs(1)).ok())
                .ok_or("PLAYBACK_NOT_CONFIRMED")
                .and_then(|output| verify_playback_completion(&output))
        } else {
            Err("PLAYBACK_WRITE_FAILED")
        })
    }
}

fn verify_playback_completion(output: &[u8]) -> Result<(), &'static str> {
    if output.len() <= 128
        && std::str::from_utf8(output).is_ok_and(|text| text.trim() == "PLAYBACK_COMPLETED")
    {
        Ok(())
    } else {
        Err("PLAYBACK_NOT_CONFIRMED")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_exit_without_completion_marker_is_not_playback_success() {
        assert_eq!(
            verify_playback_completion(b""),
            Err("PLAYBACK_NOT_CONFIRMED")
        );
        assert_eq!(
            verify_playback_completion(b"not completed"),
            Err("PLAYBACK_NOT_CONFIRMED")
        );
        assert_eq!(
            verify_playback_completion(b"PLAYBACK_COMPLETED\r\n"),
            Ok(())
        );
    }
    #[test]
    fn rejects_cancelled_invalid_or_missing_output_before_spawning() {
        let output = BridgePlayback {
            executable: PathBuf::from("missing-playback.exe"),
            endpoint_id: "test-device".into(),
        };
        assert_eq!(
            output.play(&[1, 2], 24000, || true),
            Err("PLAYBACK_CANCELLED")
        );
        assert_eq!(
            output.play(&[1], 24000, || false),
            Err("PLAYBACK_FORMAT_INVALID")
        );
        assert_eq!(
            output.play(&[1, 2], 0, || false),
            Err("PLAYBACK_FORMAT_INVALID")
        );
        assert_eq!(
            output.play(&[1, 2], 24000, || false),
            Err("SESSION_SIDECAR_MISSING")
        );
    }
}
