using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioBridge;

internal sealed class CaptureSession(uint processId)
{
    private readonly uint processId = processId;

    public async Task RunAsync(Stream pcmOutput, CancellationToken cancellationToken)
    {
        using var process = Process.GetProcessById(checked((int)processId));
        process.EnableRaisingEvents = true;
        using var processExited = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        process.Exited += (_, _) => processExited.Cancel();

        await using var recorder = await new WasapiRecorderBuilder()
            .WithProcessLoopback(processId, ProcessLoopbackMode.IncludeTargetProcessTree)
            .WithFormat(new WaveFormat(48_000, 16, 1))
            .BuildAsync();

        Console.Error.WriteLine(Protocol.Event("ready", new { captureScope = "process-tree" }));
        try
        {
            await foreach (var buffer in recorder.CaptureAsync(processExited.Token))
            {
                await pcmOutput.WriteAsync(buffer.Data, cancellationToken);
                Console.Error.WriteLine(Protocol.Event("level", new { peak = Protocol.Peak(buffer.Data.Span) }));
            }
        }
        catch (OperationCanceledException) when (process.HasExited && !cancellationToken.IsCancellationRequested)
        {
            Console.Error.WriteLine(Protocol.Event("process-exited"));
        }
    }
}
