import assert from 'node:assert/strict';
import { parsePlaylist, buildXtreamUrl, channelKey, channelSnapshot } from '../js/m3u.js';

const sample = `\uFEFF#EXTM3U url-tvg="http://epg.example/xmltv.xml,http://epg.example/2.xml"
#EXTINF:-1 tvg-id="one" tvg-name="Первый" tvg-logo="http://logo/1.png" group-title="Общие",Первый канал
#EXTVLCOPT:http-user-agent=TestUA
#EXTVLCOPT:http-referrer=http://ref.example/
http://example.com/stream1.m3u8
#EXTGRP:Спорт
#EXTINF:-1,Спорт 1
#EXTVLCOPT:http-referrer=http://ref.example/
streams/sport.m3u8
#EXTINF:-1 tvg-chno="5" group-title="Кино",Фильм "Ночь"
http://example.com/film.mp4
#EXTINF:-1,Первый канал
http://example.com/stream1.m3u8
`;

const { channels, epgUrls, isHlsManifest } = parsePlaylist(sample, { baseUrl: 'http://example.com/lists/all.m3u' });

assert.equal(channels.length, 3, 'dedupe + count');
assert.equal(channels[0].name, 'Первый канал');
assert.equal(channels[0].tvgId, 'one');
assert.equal(channels[0].logo, 'http://logo/1.png');
assert.equal(channels[0].group, 'Общие');
assert.equal(channels[0].opts.userAgent, 'TestUA');
assert.equal(channels[1].group, 'Спорт');
assert.equal(channels[1].url, 'http://example.com/lists/streams/sport.m3u8');
assert.equal(channels[2].name, 'Фильм "Ночь"');
assert.equal(channels[2].number, 5);
assert.deepEqual(epgUrls, ['http://epg.example/xmltv.xml', 'http://epg.example/2.xml']);
assert.equal(isHlsManifest, false);

const plain = parsePlaylist('http://host/a/one.m3u8\nhttp://host/a/two.ts\n', {});
assert.equal(plain.channels.length, 2);
assert.equal(plain.channels[0].name, 'one');
assert.equal(plain.channels[0].group, 'Без группы');

const manifest = parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', {});
assert.equal(manifest.channels.length, 0);
assert.equal(manifest.isHlsManifest, true);

const xtream = buildXtreamUrl('provider.tv:8080', 'user name', 'p@ss', 'm3u8');
assert.ok(xtream.startsWith('http://provider.tv:8080/get.php?'));
assert.ok(xtream.includes('username=user+name'));
assert.ok(xtream.includes('output=m3u8'));

const snap = channelSnapshot('src1', channels[0]);
assert.equal(snap.key, channelKey('src1', channels[0]));
assert.equal(snap.sourceId, 'src1');

console.log('m3u tests OK —', channels.length, 'channels parsed');