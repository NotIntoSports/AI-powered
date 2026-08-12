using AudioBridge;

if (args is ["--self-test"])
{
    var sample = new byte[] { 0xff, 0x7f, 0x00, 0x00 };
    if (Protocol.Peak(sample) < 0.99) return 2;
    if (!Protocol.Event("ready", new { captureScope = "process-tree" }).Contains("process-tree")) return 3;
    Console.WriteLine("AudioBridge self-test passed");
    return 0;
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
