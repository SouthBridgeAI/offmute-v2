node dist/cli.js -o ~/Desktop/offmute-glm/vmeeting-defaults ~/Desktop/VMeeting.mp4
[04:16:22.025] INFO === preprocess ===
[04:16:22.026] INFO === llm-transcribe ===
[04:16:22.198] INFO 5 chunks (600s, 60s overlap)
Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.
[04:16:22.199] INFO chunk 0: cached (37 segments)
[04:16:22.199] INFO chunk 1: cached (12 segments)
[04:16:22.199] INFO chunk 2: cached (89 segments)
[04:16:22.200] INFO chunk 3: cached (69 segments)
[04:16:22.200] INFO chunk 4: cached (26 segments)
[04:16:22.200] INFO total LLM segments: 233
[04:16:22.200] INFO === timestamped (AssemblyAI) ===
[04:16:22.220] INFO [assemblyai] uploading ./intermediates/audio.flac...
[04:16:27.185] INFO [assemblyai] transcribing (speech_model=universal)...
[04:16:43.444] INFO [assemblyai] done: 78 utterances, 3137 words, 2 speakers
[04:16:43.450] INFO === align ===
[04:16:44.408] INFO aligned: 233/233 with ASR timing
[04:16:44.409] INFO === consistency ===
[04:16:44.415] INFO === finalize ===
[04:16:44.656] INFO final segments: 213
[04:16:44.669] INFO outputs written to /Users/hrishioa/Desktop/offmute-glm/vmeeting-defaults
Done. 213 segments.

Voice notes:

Okay, so we are now reviewing the GLM version, right, which is awesome. Let's go. I think it's... Does it work? Okay, not this CLI. Okay, same as ever. Desktop, meeting. Can we do outputs? Yeah, output directory. Open it to LM and then VMeeting, defaults. Let's plug this in and let's go see how well that works. That folder doesn't exist. Let's see if we are running into issues. It ran a little too fast. Okay. So that's something to look out for. Like really fast. It says "ficiously fast". Oh, I don't know why it does that. It seems to have written the sort of Sachinadella transcript in there. Oh, "cash hit". Yeah, I can't do a row cached, cached, cached, cached. Okay, interesting. Okay, what happens if you do a force? That is a bug. because we, you know, well, we hit some sort of like stupid cache for one of the previously processed ones. So that is very much a bug that needs to be solved. Okay, so here we do have sort of linear sequence of stages. We'll review it. Same as the other one, we have an aligner here. Okay, now we're actually transcribing this and if I am good, we should have an intermediate folder. We don't have one. And also even when I say force to bust the cache, we get to the description and that description goes. This is a segment of a live event or podcast interview. Is that because I'm just not using it correctly, not giving the inputs properly? There's a good chance we get back the same output. So that's kind of worth looking at. That's a DX failure, I think, because I would expect to just run a node to CLI and then like, you know, the name of the meeting and then the output and it should just work. Okay, so it gets really far, same as the other version, gets really, really far and then dies if that directory doesn't exist. That would have been a nice check to have at the beginning. But that's fine, I can just make, to be fair, maybe it did exist when it started because I, you know, we need intervals, okay. If I do this again, it might actually no. What happens if I just, is it just because of the order? No, it's jumping right into the cache. do that? No, we are transcribing. Okay. Okay. So that is really strange because it goes uploading intermediate slash audio.flac. I don't know why it's doing that. When I gave it a particular parameter right out this in somewhere so we can't properly use this just yet okay but we you know for fun we'll also try the audio meeting and and we're still uploading. Yep, we hit the same cache. Okay. We seem to have hard coded like dot slash intermediates into a bunch of different places. So worth looking at, okay? Really worth looking at, okay. So that's something to fix, but until that gets fixed, I'm not sure we can do anything else. So maybe we fix that first. Just a cache issue, whatever that is.
