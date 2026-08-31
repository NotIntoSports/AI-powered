class AgentAudioTrack:
    def __init__(self, room, *, rtc_module=None, sample_rate: int = 24000) -> None:
        self.room = room
        self.rtc = rtc_module
        self.sample_rate = sample_rate
        self.frame_bytes = sample_rate * 2 * 20 // 1000
        self.buffer = bytearray()
        self.source = None

    async def start(self) -> None:
        if self.rtc is None:
            from livekit import rtc
            self.rtc = rtc
        self.source = self.rtc.AudioSource(self.sample_rate, 1, 100_000)
        track = self.rtc.LocalAudioTrack.create_audio_track("agent-voice", self.source)
        options = self.rtc.TrackPublishOptions()
        options.source = self.rtc.TrackSource.SOURCE_MICROPHONE
        await self.room.local_participant.publish_track(track, options)

    async def write(self, pcm: bytes) -> None:
        if self.source is None:
            raise RuntimeError("AGENT_AUDIO_NOT_STARTED")
        self.buffer.extend(pcm)
        while len(self.buffer) >= self.frame_bytes:
            chunk = bytes(self.buffer[: self.frame_bytes])
            del self.buffer[: self.frame_bytes]
            await self.source.capture_frame(self.rtc.AudioFrame(data=chunk, sample_rate=self.sample_rate, num_channels=1, samples_per_channel=self.frame_bytes // 2))

    async def flush(self) -> None:
        if self.source is None:
            return
        if self.buffer:
            chunk = bytes(self.buffer) + bytes(self.frame_bytes - len(self.buffer))
            self.buffer.clear()
            await self.source.capture_frame(self.rtc.AudioFrame(data=chunk, sample_rate=self.sample_rate, num_channels=1, samples_per_channel=self.frame_bytes // 2))
        await self.source.wait_for_playout()

    async def close(self) -> None:
        if self.source is not None:
            await self.flush()
            await self.source.aclose()
            self.source = None


async def publish_pcm(room, pcm: bytes, *, rtc_module=None, sample_rate: int = 24000) -> None:
    output = AgentAudioTrack(room, rtc_module=rtc_module, sample_rate=sample_rate)
    await output.start()
    try:
        await output.write(pcm)
        await output.flush()
    finally:
        await output.close()
