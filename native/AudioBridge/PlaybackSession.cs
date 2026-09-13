using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioBridge;

internal static class PlaybackSession
{
    public static object[] ListAudioDevices()
    {
        using var devices = new MMDeviceEnumerator();
        var result = new List<object>();
        foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
        {
            foreach (var device in devices.EnumerateAudioEndPoints(flow, DeviceState.All))
            {
                using (device) result.Add(new { id = device.ID, name = device.FriendlyName, flow = flow == DataFlow.Render ? "render" : "capture", state = device.State.ToString() });
            }
        }
        return result.ToArray();
    }

    // Raw mono PCM only. Keep the payload in memory and reject oversized input.
    public static async Task PlayAsync(string endpointId, int sampleRate, Stream input)
    {
        if (sampleRate is < 8000 or > 48000 || string.IsNullOrWhiteSpace(endpointId))
            throw new ArgumentException("INVALID_PLAYBACK_FORMAT");
        const int maxBytes = 16 * 1024 * 1024;
        using var pcm = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(buffer)) > 0)
        {
            if (pcm.Length + count > maxBytes) throw new InvalidDataException("PCM_TOO_LARGE");
            await pcm.WriteAsync(buffer.AsMemory(0, count));
        }
        if (pcm.Length == 0 || pcm.Length % 2 != 0) throw new InvalidDataException("INVALID_PCM");
        pcm.Position = 0;
        using var devices = new MMDeviceEnumerator();
        using var device = devices.GetDevice(endpointId);
        if (device.State != DeviceState.Active || device.DataFlow != DataFlow.Render)
            throw new InvalidOperationException("OUTPUT_DEVICE_UNAVAILABLE");
        using var source = new RawSourceWaveStream(pcm, new WaveFormat(sampleRate, 16, 1));
        await using var player = await new WasapiPlayerBuilder().WithDevice(device).BuildAsync();
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        player.PlaybackStopped += (_, stopped) => {
            if (stopped.Exception is not null) completion.TrySetException(stopped.Exception);
            else completion.TrySetResult();
        };
        player.Init(source);
        player.Play();
        await completion.Task.WaitAsync(TimeSpan.FromSeconds(pcm.Length / (sampleRate * 2.0) + 10));
    }

    public static object[] ListOutputs()
    {
        using var devices = new MMDeviceEnumerator();
        var result = new List<object>();
        foreach (var device in devices.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device) result.Add(new { id = device.ID, name = device.FriendlyName });
        }
        return result.ToArray();
    }
}
