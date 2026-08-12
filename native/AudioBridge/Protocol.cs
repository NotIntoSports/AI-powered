using System.Text.Json;

namespace AudioBridge;

internal static class Protocol
{
    private static long sequence;

    public static string Event(string type, object? details = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["type"] = type,
            ["sequence"] = Interlocked.Increment(ref sequence) - 1
        };
        if (details is not null)
        {
            foreach (var property in details.GetType().GetProperties())
            {
                payload[char.ToLowerInvariant(property.Name[0]) + property.Name[1..]] = property.GetValue(details);
            }
        }
        return JsonSerializer.Serialize(payload);
    }

    public static double Peak(ReadOnlySpan<byte> pcm16)
    {
        var maximum = 0;
        for (var offset = 0; offset + 1 < pcm16.Length; offset += 2)
        {
            var sample = Math.Abs((int)BitConverter.ToInt16(pcm16.Slice(offset, 2)));
            if (sample > maximum) maximum = sample;
        }
        return Math.Min(1d, maximum / 32768d);
    }
}
