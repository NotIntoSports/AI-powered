//! AudioBridge sidecar wrap. Tests inject PCM; live spawn is skipped when the exe is absent.

use std::{
    fmt,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

use super::pcm::{PcmRing, downsample_48k_to_16k};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioError {
    ExeMissing,
    InvalidPid,
    SpawnFailed,
    SidecarFailed,
}

impl AudioError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ExeMissing => "SESSION_SIDECAR_MISSING",
            Self::InvalidPid => "SESSION_SIDECAR_INVALID_PID",
            Self::SpawnFailed => "SESSION_SIDECAR_SPAWN_FAILED",
            Self::SidecarFailed => "SESSION_SIDECAR_FAILED",
        }
    }
}

impl fmt::Display for AudioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for AudioError {}

pub trait PlaybackSink {
    fn play_pcm(&mut self, pcm: &[u8], sample_rate: u32);
    fn cancel(&mut self);
}

#[derive(Debug, Default)]
pub struct NoopSink;

impl PlaybackSink for NoopSink {
    fn play_pcm(&mut self, _pcm: &[u8], _sample_rate: u32) {}

    fn cancel(&mut self) {}
}

#[derive(Debug, Default)]
pub struct RecordingSink {
    frames: Vec<u8>,
    sample_rate: Option<u32>,
    cancelled: bool,
}

impl RecordingSink {
    pub fn recorded(&self) -> &[u8] {
        &self.frames
    }

    pub fn sample_rate(&self) -> Option<u32> {
        self.sample_rate
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled
    }
}

impl PlaybackSink for RecordingSink {
    fn play_pcm(&mut self, pcm: &[u8], sample_rate: u32) {
        self.frames.extend_from_slice(pcm);
        self.sample_rate = Some(sample_rate);
    }

    fn cancel(&mut self) {
        self.cancelled = true;
    }
}

pub fn bridge_command_args(pid: u32) -> Vec<String> {
    vec!["--pid".into(), pid.to_string()]
}

pub fn parse_level_peak(line: &str) -> Option<f64> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "level" {
        return None;
    }
    value.get("peak")?.as_f64()
}

#[derive(Debug)]
struct CaptureState {
    ring: PcmRing,
    last_peak: f64,
}

#[derive(Debug)]
pub struct AudioCapture {
    state: Arc<Mutex<CaptureState>>,
    child: Option<Child>,
    spawn: Option<(PathBuf, u32)>,
    restarts: u8,
}

impl AudioCapture {
    pub fn from_injected() -> Self {
        Self::empty()
    }

    pub fn spawn_bridge(exe: &Path, pid: u32) -> Result<Self, AudioError> {
        if pid == 0 {
            return Err(AudioError::InvalidPid);
        }
        if !exe.is_file() {
            return Err(AudioError::ExeMissing);
        }
        let mut capture = Self::empty();
        capture.spawn = Some((exe.to_path_buf(), pid));
        capture.start_child(exe, pid)?;
        Ok(capture)
    }

    pub fn push_pcm(&mut self, pcm: &[u8]) {
        self.lock().ring.push(pcm);
    }

    pub fn ingest_event_line(&mut self, line: &str) {
        if let Some(peak) = parse_level_peak(line) {
            self.lock().last_peak = peak;
        }
    }

    pub fn last_peak(&self) -> f64 {
        self.lock().last_peak
    }

    pub fn snapshot_48k(&self) -> Vec<u8> {
        self.lock().ring.snapshot()
    }

    pub fn pcm_for_asr(&self) -> Vec<u8> {
        downsample_48k_to_16k(&self.snapshot_48k())
    }

    pub fn overrun_count(&self) -> u32 {
        self.lock().ring.overrun_count()
    }

    pub fn restart_once(&mut self) -> Result<(), AudioError> {
        if self.restarts >= 1 {
            return Err(AudioError::SidecarFailed);
        }
        self.restarts += 1;
        if let Some((exe, pid)) = self.spawn.clone() {
            self.stop_child();
            self.start_child(&exe, pid)?;
        }
        Ok(())
    }

    fn empty() -> Self {
        Self {
            state: Arc::new(Mutex::new(CaptureState {
                ring: PcmRing::new(),
                last_peak: 0.0,
            })),
            child: None,
            spawn: None,
            restarts: 0,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CaptureState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start_child(&mut self, exe: &Path, pid: u32) -> Result<(), AudioError> {
        let mut child = Command::new(exe)
            .args(bridge_command_args(pid))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|_| AudioError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(AudioError::SpawnFailed)?;
        let stderr = child.stderr.take().ok_or(AudioError::SpawnFailed)?;
        let pcm_state = Arc::clone(&self.state);
        std::thread::spawn(move || drain_pcm(stdout, pcm_state));
        let event_state = Arc::clone(&self.state);
        std::thread::spawn(move || drain_events(stderr, event_state));
        self.child = Some(child);
        Ok(())
    }

    fn stop_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn drain_pcm(mut stdout: impl Read, state: Arc<Mutex<CaptureState>>) {
    let mut buf = [0_u8; 8192];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .ring
                .push(&buf[..n]),
        }
    }
}

fn drain_events(stderr: impl Read, state: Arc<Mutex<CaptureState>>) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(peak) = parse_level_peak(&line) {
            state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .last_peak = peak;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AudioCapture, AudioError, NoopSink, PlaybackSink, RecordingSink, bridge_command_args,
        parse_level_peak,
    };
    use crate::audio::pcm::RING_CAPACITY_BYTES;
    use std::path::PathBuf;

    fn le_i16(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[test]
    fn from_injected_stores_pcm_in_memory_ring() {
        let mut capture = AudioCapture::from_injected();
        let pcm = le_i16(&[100, 200, 300]);
        capture.push_pcm(&pcm);
        assert_eq!(capture.snapshot_48k(), pcm);
        assert_eq!(capture.overrun_count(), 0);
        assert_eq!(capture.pcm_for_asr(), le_i16(&[200]));
    }

    #[test]
    fn injected_overrun_drops_oldest() {
        let mut capture = AudioCapture::from_injected();
        capture.push_pcm(&vec![0x10; RING_CAPACITY_BYTES]);
        capture.push_pcm(&[0xFE, 0xFF]);
        assert_eq!(capture.overrun_count(), 1);
        let snap = capture.snapshot_48k();
        assert_eq!(snap.len(), RING_CAPACITY_BYTES);
        assert_eq!(&snap[RING_CAPACITY_BYTES - 2..], &[0xFE, 0xFF]);
    }

    #[test]
    fn parses_level_json_and_ignores_other_events() {
        let mut capture = AudioCapture::from_injected();
        capture.ingest_event_line(r#"{"type":"level","sequence":0,"peak":0.42}"#);
        assert!((capture.last_peak() - 0.42).abs() < 1e-9);
        capture.ingest_event_line(r#"{"type":"ready","sequence":1,"captureScope":"process-tree"}"#);
        assert!((capture.last_peak() - 0.42).abs() < 1e-9);
        assert_eq!(
            parse_level_peak(r#"{"type":"level","sequence":2,"peak":0.75}"#),
            Some(0.75)
        );
        assert_eq!(
            parse_level_peak(r#"{"type":"process-exited","sequence":3}"#),
            None
        );
    }

    #[test]
    fn restart_once_then_second_crash_fails() {
        let mut capture = AudioCapture::from_injected();
        capture
            .restart_once()
            .expect("first sidecar restart is allowed");
        let error = capture
            .restart_once()
            .expect_err("second crash is terminal");
        assert_eq!(error, AudioError::SidecarFailed);
        assert_eq!(error.code(), "SESSION_SIDECAR_FAILED");
    }

    #[test]
    fn spawn_bridge_skips_when_exe_absent() {
        let missing = PathBuf::from("definitely-missing-AudioBridge.exe");
        assert!(!missing.is_file());
        let error = AudioCapture::spawn_bridge(&missing, 4242).expect_err("missing exe");
        assert_eq!(error, AudioError::ExeMissing);
        assert_eq!(error.code(), "SESSION_SIDECAR_MISSING");
    }

    #[test]
    fn spawn_bridge_rejects_pid_zero() {
        let missing = PathBuf::from("definitely-missing-AudioBridge.exe");
        let error = AudioCapture::spawn_bridge(&missing, 0).expect_err("pid 0");
        assert_eq!(error, AudioError::InvalidPid);
    }

    #[test]
    fn bridge_args_match_csharp_pid_flag() {
        assert_eq!(bridge_command_args(99), ["--pid", "99"]);
    }

    #[test]
    fn recording_sink_stores_bytes_and_cancel() {
        let mut sink = RecordingSink::default();
        sink.play_pcm(&[0x11, 0x22, 0x33, 0x44], 24_000);
        sink.cancel();
        assert_eq!(sink.recorded(), &[0x11, 0x22, 0x33, 0x44]);
        assert_eq!(sink.sample_rate(), Some(24_000));
        assert!(sink.cancelled());
    }

    #[test]
    fn default_sink_is_noop() {
        let mut sink = NoopSink;
        sink.play_pcm(&[0x01, 0x02], 16_000);
        sink.cancel();
    }
}
