import { beta } from '@livekit/agents-plugin-google';
import { tts, AsyncIterableQueue } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

export class GoogleGeminiTTS extends tts.TTS {
    constructor(opts) {
        // We set streaming: false so LiveKit's TTSStreamAdapter handles sentence tokenization for us.
        // This dramatically reduces latency compared to waiting for the FULL AI response text!
        super(24000, 1, { streaming: false });
        this.geminiTts = new beta.TTS(opts);
        this.label = `GoogleGeminiTTS<${this.geminiTts.label}>`;
    }
    
    synthesize(text, connOptions, abortSignal) {
        const geminiStream = this.geminiTts.synthesize(text, connOptions, abortSignal);
        
        // Return a custom iterable queue so we can actually push to it asynchronously from the timer
        // You cannot 'yield' inside an interval in an async generator, but you CAN put into a queue!
        const queue = new AsyncIterableQueue();
        
        // 1. Immediately push 1 keep-alive frame
        const silentData = new Int16Array(240); // 10ms of silence
        queue.put({
            frame: new AudioFrame(silentData, 24000, 1, 240),
            requestId: 'keepalive',
            segmentId: 'keepalive',
            final: false
        });

        let realFrameReceived = false;

        // 2. Fire keep-alive every 3 seconds into the queue
        const interval = setInterval(() => {
            if (!realFrameReceived && (!abortSignal || !abortSignal.aborted)) {
                queue.put({
                    frame: new AudioFrame(silentData, 24000, 1, 240),
                    requestId: 'keepalive-interval',
                    segmentId: 'keepalive-interval',
                    final: false
                });
            }
        }, 3000);

        // 3. Process Gemini stream and forward to queue
        (async () => {
            try {
                for await (const chunk of geminiStream) {
                    if (abortSignal && abortSignal.aborted) break;
                    realFrameReceived = true;
                    // Usually we don't need to clear interval immediately, but it's safe to
                    clearInterval(interval);
                    queue.put(chunk);
                }
            } catch (err) {
                console.error(`[GoogleGeminiTTS] Error from Gemini API:`, err);
            } finally {
                clearInterval(interval);
                queue.close();
            }
        })();

        return queue;
    }
}

