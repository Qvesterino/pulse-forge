import { Scheduler } from './src/scheduler/Scheduler.ts';
import { Transport } from './src/transport/Transport.ts';
import { createDefaultProject } from './src/project-model/schema.ts';
import { BAR_TICKS } from './src/project-model/types.ts';

const doc = createDefaultProject();
let audioTime = 10;
const transport = new Transport({ now: () => audioTime }, doc.bpm);
const scheduler = new Scheduler({
  getProject: () => doc,
  getTransport: () => transport,
  getAudioTime: () => audioTime,
  getMode: () => 'song',
  trigger: () => {},
  noteOn: () => {},
  applyAutomation: () => {},
});

transport.setLoop(true, 0, BAR_TICKS);
console.log('after setLoop: loopEnabled=', transport.loopEnabled, 'loopStart=', transport.loopStart, 'loopEnd=', transport.loopEnd);
transport.play(0);
console.log('after play: position=', transport.position, 'playing=', transport.playing);
audioTime = 12;
console.log('after advance: position=', transport.position);
scheduler['tick']();
console.log('after tick: position=', transport.position, 'playing=', transport.playing, 'loopEnabled=', transport.loopEnabled);
