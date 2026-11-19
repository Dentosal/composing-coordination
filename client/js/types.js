// JSDoc mirror of the orders format. Source of truth: renderer/src/orders.rs.

/** @typedef {'sine'|'square'|'sawtooth'|'triangle'} Wave */
/** @typedef {'lowpass'|'highpass'|'bandpass'|'notch'} FilterMode */
/**
 * @typedef {{id:string,type:'osc',wave:Wave,semitones?:number,detune?:number,fixed_hz?:number|null,unison?:number,spread?:number}
 *  | {id:string,type:'noise',color:'white'|'pink'|'brown'}
 *  | {id:string,type:'gain',gain:number,key_track?:number}
 *  | {id:string,type:'filter',mode:FilterMode,freq:number,q:number,key_track?:number}
 *  | {id:string,type:'env',attack:number,decay:number,sustain:number,release:number,amount:number}
 *  | {id:string,type:'shaper',drive:number,shape?:'soft'|'hard'|'fold'|'asym'|'crush',param?:number}
 *  | {id:string,type:'out'}} OrdersNode
 */
/** @typedef {{from:string,to:string,port?:string|null}} OrdersEdge */
/** @typedef {{id:string,name?:string,piano_roll?:boolean,gain:number,send_delay:number,send_reverb:number,nodes:OrdersNode[],edges:OrdersEdge[]}} OrdersInstrument */
/** @typedef {{row:number,note:number|null,vel:number}} OrdersStep  note null = note-off */
/** @typedef {{node:string,port:string,value:number,glide?:boolean}} OrdersParam  one automated node parameter of an effect cell (see automation.js) */
/** @typedef {{row:number,volume?:number,arp?:{offsets:number[]},slide?:number,cut?:number,retrig?:number,params?:OrdersParam[]}} OrdersFx  effect cell: applies during its row */
/** @typedef {{instrument:string,steps:OrdersStep[],fx?:OrdersFx[]}} OrdersLane */
/** @typedef {{instruments:OrdersInstrument[],lanes:OrdersLane[]}} Orders */

/**
 * @typedef {{bpm:number,bars:number,rows_per_bar:number,max_lanes:number,
 *  max_instruments:number,rounds:number|null,round_timer_secs:number|null,
 *  timeout_policy:'Wait'|'RepeatLast',seed:string}} SessionConfig
 */

export {};
