using AudioBridge;
using System.Text.Json;

if (args is ["--list-output-devices"])
{
    try { Console.WriteLine(JsonSerializer.Serialize(PlaybackSession.ListOutputs())); return 0; }
    catch { Console.Error.WriteLine("OUTPUT_ENUMERATION_FAILED"); return 1; }
}

if (args is ["--list-audio-devices"])
{
    try { Console.WriteLine(JsonSerializer.Serialize(PlaybackSession.ListAudioDevices())); return 0; }
    catch { Console.Error.WriteLine("AUDIO_ENUMERATION_FAILED"); return 1; }
}

if (args is ["--play-pcm", var outputId, var rate] && int.TryParse(rate, out var sampleRate))
{
    try {
        await PlaybackSession.PlayAsync(outputId, sampleRate, Console.OpenStandardInput());
        Console.WriteLine("PLAYBACK_COMPLETED");
        return 0;
    }
    catch { Console.Error.WriteLine("PLAYBACK_FAILED"); return 1; }
}

if (args is ["--monitor-input", var inputId, var monitorOutputId])
{
    using var monitorCancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, eventArgs) => {
        eventArgs.Cancel = true;
        monitorCancellation.Cancel();
    };
    try
    {
        await MicrophoneMonitor.RunAsync(inputId, monitorOutputId, monitorCancellation.Token);
        return 0;
    }
    catch (OperationCanceledException) { return 0; }
    catch { Console.Error.WriteLine("MONITOR_FAILED"); return 1; }
}

if (args is ["--self-test"])
{
    var restored = false;
    CommunicationsMicrophone.RestoreIfUnchanged("original", "cable", () => "user-choice", _ => restored = true);
    if (restored) return 4;
    var current = "cable";
    CommunicationsMicrophone.RestoreIfUnchanged("original", "cable", () => current, value => current = value);
    if (current != "original") return 5;
    var sample = new byte[] { 0xff, 0x7f, 0x00, 0x00 };
    if (Protocol.Peak(sample) < 0.99) return 2;
    if (!Protocol.Event("ready", new { captureScope = "process-tree" }).Contains("process-tree")) return 3;
    Console.WriteLine("AudioBridge self-test passed");
    return 0;
}

if (args is ["--set-default-communications-mic", var captureId])
{
    try
    {
        var change = CommunicationsMicrophone.UseCableOutput(captureId);
        Console.WriteLine(JsonSerializer.Serialize(new {
            changed = change.Changed,
            previousId = change.PreviousId,
            cableId = change.CableId,
            cableLabel = change.CableLabel
        }));
        return 0;
    }
    catch (Exception error)
    {
        Console.Error.WriteLine(error.Message);
        return 1;
    }
}

if (args is ["--restore-default-communications-mic", var endpointId, var expectedCurrentId])
{
    try { CommunicationsMicrophone.Restore(endpointId, expectedCurrentId); return 0; }
    catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
}

if (args.Length != 2 || args[0] != "--pid" || !uint.TryParse(args[1], out var processId) || processId == 0)
{
    Console.Error.WriteLine(Protocol.Event("error", new {
        code = "invalid-arguments",
        message = "Usage: AudioBridge --pid <positive process id>"
    }));
    return 64;
}

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) => {
    eventArgs.Cancel = true;
    cancellation.Cancel();
};

try
{
    await new CaptureSession(processId).RunAsync(Console.OpenStandardOutput(), cancellation.Token);
    return 0;
}
catch (OperationCanceledException)
{
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(Protocol.Event("error", new {
        code = "capture-failed",
        message = error.Message
    }));
    return 1;
}
