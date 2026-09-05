//! 48 kHz 16-bit mono PCM ring and 16 kHz downsample for ASR.

use std::collections::VecDeque;

pub const CAPTURE_SAMPLE_RATE: u32 = 48_000;
pub const ASR_SAMPLE_RATE: u32 = 16_000;
pub const RING_SECONDS: usize = 3;
pub const BYTES_PER_SAMPLE: usize = 2;
pub const RING_CAPACITY_BYTES: usize =
    CAPTURE_SAMPLE_RATE as usize * BYTES_PER_SAMPLE * RING_SECONDS;

#[derive(Debug)]
pub struct PcmRing {
    buf: VecDeque<u8>,
    overrun_count: u32,
}

impl Default for PcmRing {
    fn default() -> Self {
        Self::new()
    }
}

impl PcmRing {
    pub fn new() -> Self {
        Self {
            buf: VecDeque::with_capacity(RING_CAPACITY_BYTES),
            overrun_count: 0,
        }
    }

    pub fn push(&mut self, pcm: &[u8]) {
        let data = even_prefix(pcm);
        if data.is_empty() {
            return;
        }
        if data.len() > RING_CAPACITY_BYTES {
            self.buf.clear();
            self.buf
                .extend(data[data.len() - RING_CAPACITY_BYTES..].iter().copied());
            self.overrun_count = self.overrun_count.saturating_add(1);
            return;
        }
        let overflow = self
            .buf
            .len()
            .saturating_add(data.len())
            .saturating_sub(RING_CAPACITY_BYTES);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.overrun_count = self.overrun_count.saturating_add(1);
        }
        self.buf.extend(data.iter().copied());
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn overrun_count(&self) -> u32 {
        self.overrun_count
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// Average each group of 3 little-endian i16 samples into one (48 kHz → 16 kHz).
pub fn downsample_48k_to_16k(pcm48: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut group = [0_i16; 3];
    let mut filled = 0;
    for chunk in even_prefix(pcm48).chunks_exact(BYTES_PER_SAMPLE) {
        group[filled] = i16::from_le_bytes([chunk[0], chunk[1]]);
        filled += 1;
        if filled == 3 {
            let sum = i32::from(group[0]) + i32::from(group[1]) + i32::from(group[2]);
            out.extend_from_slice(&((sum / 3) as i16).to_le_bytes());
            filled = 0;
        }
    }
    out
}

fn even_prefix(pcm: &[u8]) -> &[u8] {
    if pcm.len().is_multiple_of(2) {
        pcm
    } else {
        &pcm[..pcm.len() - 1]
    }
}

#[cfg(test)]
mod tests {
    use super::{PcmRing, RING_CAPACITY_BYTES, downsample_48k_to_16k};

    fn le_i16(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    #[test]
    fn ring_keeps_last_three_seconds_and_increments_overrun() {
        let mut ring = PcmRing::new();
        let fill = vec![0x11_u8; RING_CAPACITY_BYTES];
        ring.push(&fill);
        assert_eq!(ring.len(), RING_CAPACITY_BYTES);
        assert_eq!(ring.overrun_count(), 0);

        ring.push(&[0x22, 0x33]);
        assert_eq!(ring.overrun_count(), 1);
        let snap = ring.snapshot();
        assert_eq!(snap.len(), RING_CAPACITY_BYTES);
        assert_eq!(&snap[..2], &[0x11, 0x11]);
        assert_eq!(&snap[RING_CAPACITY_BYTES - 2..], &[0x22, 0x33]);
    }

    #[test]
    fn ring_oversize_chunk_keeps_newest_bytes() {
        let mut ring = PcmRing::new();
        let mut huge = vec![0x01_u8; RING_CAPACITY_BYTES + 4];
        huge[RING_CAPACITY_BYTES] = 0xAA;
        huge[RING_CAPACITY_BYTES + 1] = 0xBB;
        huge[RING_CAPACITY_BYTES + 2] = 0xCC;
        huge[RING_CAPACITY_BYTES + 3] = 0xDD;
        ring.push(&huge);
        assert_eq!(ring.overrun_count(), 1);
        let snap = ring.snapshot();
        assert_eq!(snap.len(), RING_CAPACITY_BYTES);
        assert_eq!(&snap[RING_CAPACITY_BYTES - 4..], &[0xAA, 0xBB, 0xCC, 0xDD]);
    }

    #[test]
    fn downsample_averages_each_three_samples() {
        let pcm = le_i16(&[300, 600, 900, -3, -6, -9]);
        assert_eq!(downsample_48k_to_16k(&pcm), le_i16(&[600, -6]));
    }
}
