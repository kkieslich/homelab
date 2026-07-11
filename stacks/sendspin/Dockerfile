# Official OHF reference Sendspin player (Python/async) — the maintained,
# reliable player. Replaces the community `sendspin-go` client, whose websocket
# read-loop does blocking channel sends and deadlocks during sustained playback
# (a full consumer channel wedges the socket reader → no sync, no reconnect).
# The Python client (same family as LedFX's, which never wedged here) is robust.
FROM python:3.12-slim

# sounddevice's PortAudio backend + the ALSA→PulseAudio plugin, so audio routes
# through the host sound server (PULSE_SERVER points at the couch PipeWire
# socket at runtime → Radeon HDMI → Denon AVR).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libportaudio2 libasound2-plugins \
 && rm -rf /var/lib/apt/lists/*

# Route ALSA 'default'/'pulse' to the sound server.
RUN printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > /etc/asound.conf

# Pin aiosendspin to the version Music Assistant runs (6.1.1) so the MediaCommand
# schema matches — otherwise server/state messages (e.g. the 'seek' command) fail
# to parse and spam the log. sendspin 7.5.0 works fine with 6.1.1 (verified). If
# MA's aiosendspin later bumps and re-introduces the parse warning, bump this pin.
RUN pip install --no-cache-dir sendspin==7.5.0 \
 && pip install --no-cache-dir aiosendspin==6.1.1

ENTRYPOINT ["sendspin"]
