const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const urls = [
  'https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8',
  'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8',
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://test-streams.mux.dev/pts_shift/master.m3u8',
  'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
  'https://bitdash-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8',
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
  'https://test-streams.mux.dev/tos_ismc/main.m3u8',
];

const headers = { 'user-agent': UA, accept: '*/*' };

async function get(url, method = 'GET') {
  const res = await fetch(url, { headers, method, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text, url: res.url };
}

function firstUri(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    return new URL(line, base).href;
  }
  return null;
}

for (const master of urls) {
  try {
    const m = await get(master);
    if (!m.ok) {
      console.log(`${m.status} master  ${master}`);
      continue;
    }
    const variant = firstUri(m.text, m.url);
    let vStatus = '-';
    let segStatus = '-';
    if (variant && /\.m3u8/.test(variant)) {
      const v = await get(variant);
      vStatus = v.status;
      if (v.ok) {
        const seg = firstUri(v.text, v.url);
        if (seg) {
          const s = await get(seg, 'HEAD');
          segStatus = s.status;
        }
      }
    }
    console.log(`${m.status} master / variant ${vStatus} / segment ${segStatus}  ${master}`);
  } catch (err) {
    console.log(`ERR ${master} -> ${err.message}`);
  }
}