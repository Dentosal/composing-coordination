// The streaming player check page (stream-test.html): loops a demo song through StreamPlayer and shows its health.
import { StreamPlayer } from './stream.js';

const $ = (id) => document.getElementById(id);
let scene = null;
const player = new StreamPlayer({ config: () => scene.config, parts: () => [{ seat: 0, orders: scene.orders }] });
let timer = null;

$('iso').textContent = StreamPlayer.supported ? 'yes' : 'NO: the server must send the COOP and COEP headers';
if (!StreamPlayer.supported) $('iso').className = 'bad';
player.warm();

const demos = await (await fetch('demos/index.json')).json();
for (const d of demos) $('song').append(new Option(`${d.title} (${d.bpm} BPM, ${d.tracks} tracks)`, d.file));
$('song').value = demos.at(-1)?.file ?? '';

function update() {
  const s = player.stats();
  const pos = player.position();
  if (pos != null) $('pos').textContent = `${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, '0')}`;
  if (s) {
    $('buf').textContent = `${Math.round(s.ahead * 1000)} ms`;
    $('under').textContent = String(s.underruns);
    $('under').className = s.underruns ? 'bad' : '';
  }
  if (player.error) $('status').textContent = `error: ${player.error}`;
}

$('play').addEventListener('click', async () => {
  player.stop();
  scene = await (await fetch(`demos/${$('song').value}.json`)).json();
  await player.play();
  $('status').textContent = 'playing (loops the song)';
  clearInterval(timer);
  timer = setInterval(update, 100);
});
$('stop').addEventListener('click', () => {
  player.stop();
  clearInterval(timer);
  $('status').textContent = 'stopped';
});
