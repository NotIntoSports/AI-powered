import asyncio
import unittest

from audio_track import AgentAudioTrack, publish_pcm


class FakeSource:
    def __init__(self, sample_rate, channels, queue_size_ms):
        self.args = (sample_rate, channels, queue_size_ms)
        self.frames = []
    async def capture_frame(self, frame): self.frames.append(frame)
    async def wait_for_playout(self): pass
    async def aclose(self): pass


class FakeRTC:
    source = None
    class AudioSource:
        def __new__(cls, *args):
            FakeRTC.source = FakeSource(*args)
            return FakeRTC.source
    class AudioFrame:
        def __init__(self, data, sample_rate, num_channels, samples_per_channel):
            self.data, self.sample_rate, self.num_channels, self.samples_per_channel = data, sample_rate, num_channels, samples_per_channel
    class LocalAudioTrack:
        @staticmethod
        def create_audio_track(name, source): return (name, source)
    class TrackPublishOptions: pass
    class TrackSource: SOURCE_MICROPHONE = "microphone"


class Participant:
    def __init__(self): self.published = []
    async def publish_track(self, track, options): self.published.append((track, options))


class Room:
    def __init__(self): self.local_participant = Participant()


class AudioTrackTests(unittest.TestCase):
    def test_publishes_pcm_as_agent_audio_track(self):
        room = Room()
        asyncio.run(publish_pcm(room, bytes(1920), rtc_module=FakeRTC, sample_rate=24000))
        self.assertEqual(room.local_participant.published[0][0][0], "agent-voice")
        self.assertEqual(len(FakeRTC.source.frames), 2)
        self.assertEqual(FakeRTC.source.frames[0].samples_per_channel, 480)

    def test_reuses_one_published_track_for_multiple_chunks(self):
        room = Room()
        async def scenario():
            output = AgentAudioTrack(room, rtc_module=FakeRTC, sample_rate=24000)
            await output.start()
            await output.write(bytes(960))
            await output.write(bytes(960))
            await output.close()
        asyncio.run(scenario())
        self.assertEqual(len(room.local_participant.published), 1)
        self.assertEqual(len(FakeRTC.source.frames), 2)


if __name__ == "__main__": unittest.main()
