using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioBridge;

internal static class MicrophoneMonitor
{
    public static async Task RunAsync(string inputId, string outputId, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(inputId) || string.IsNullOrWhiteSpace(outputId))
            throw new ArgumentException("MONITOR_DEVICE_INVALID");

        using var devices = new MMDeviceEnumerator();
        using var input = devices.GetDevice(inputId);
        using var output = devices.GetDevice(outputId);
        if (input.State != DeviceState.Active || input.DataFlow != DataFlow.Capture)
            throw new InvalidOperationException("MONITOR_INPUT_UNAVAILABLE");
        if (output.State != DeviceState.Active || output.DataFlow != DataFlow.Render)
            throw new InvalidOperationException("MONITOR_OUTPUT_UNAVAILABLE");

        await using var capture = await new WasapiRecorderBuilder()
            .WithDevice(input)
            .WithSharedMode()
            .WithEventSync()
            .WithBufferLength(30)
            .BuildAsync();
        var buffer = new BufferedWaveProvider(capture.WaveFormat, TimeSpan.FromSeconds(2))
        {
            DiscardOnBufferOverflow = true,
            ReadFully = true,
        };
        await using var player = await new WasapiPlayerBuilder()
            .WithDevice(output)
            .WithSharedMode()
            .WithEventSync()
            .WithLatency(50)
            .BuildAsync();
        var stopped = new TaskCompletionSource<Exception?>(TaskCreationOptions.RunContinuationsAsynchronously);
        capture.DataAvailable += (available, _, _, _) => buffer.AddSamples(available);
        capture.RecordingStopped += (_, result) => stopped.TrySetResult(result.Exception);
        player.PlaybackStopped += (_, result) =>
        {
            if (result.Exception is not null) stopped.TrySetResult(result.Exception);
        };
        player.Init(buffer);
        player.Play();
        capture.StartRecording();
        Console.WriteLine("MONITOR_READY");

        try
        {
            var cancelled = Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
            await Task.WhenAny(stopped.Task, cancelled);
        }
        finally
        {
            capture.StopRecording();
            player.Stop();
        }

        if (stopped.Task.IsCompletedSuccessfully && stopped.Task.Result is Exception error)
            throw error;
        cancellation.ThrowIfCancellationRequested();
    }
}
