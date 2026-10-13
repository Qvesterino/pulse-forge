const BUTTER_Q = 0.7071067811865475;
const sr = 48000;
function lpProto(fc, sr) { const w0=2*Math.PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0), alpha=sin/(2*BUTTER_Q), a0=1+alpha;
  return { b0:(1-cos)/2/a0, b1:(1-cos)/a0, b2:(1-cos)/2/a0, a1:(-2*cos)/a0, a2:(1-alpha)/a0 }; }
function hpProto(fc, sr) { const w0=2*Math.PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0), alpha=sin/(2*BUTTER_Q), a0=1+alpha;
  return { b0:(1+cos)/2/a0, b1:-(1+cos)/a0, b2:(1+cos)/2/a0, a1:(-2*cos)/a0, a2:(1-alpha)/a0 }; }
function peakProto(fc, gdb, q, sr) { const A=Math.pow(10,gdb/40), w0=2*Math.PI*fc/sr, cos=Math.cos(w0), sin=Math.sin(w0), alpha=sin/(2*q), a0=1+alpha/A;
  return { b0:(1+alpha*A)/a0, b1:(-2*cos)/a0, b2:(1-alpha*A)/a0, a1:(-2*cos)/a0, a2:(1-alpha/A)/a0 }; }
function decrampedQ(q,fc,sr){ const x=Math.PI*fc/sr, s=Math.sin(x); return s<1e-6?q:(q*x)/s; }
function mag(p,w){ const c1=Math.cos(-w), s1=Math.sin(-w), c2=Math.cos(-2*w), s2=Math.sin(-2*w);
  const nr=p.b0+p.b1*c1+p.b2*c2, ni=p.b1*s1+p.b2*s2, dr=1+p.a1*c1+p.a2*c2, di=p.a1*s1+p.a2*s2;
  const den=dr*dr+di*di; if(den===0) return 0; return Math.hypot(nr*dr+ni*di, ni*dr-nr*di)/den; }
const db=(m)=>20*Math.log10(m);
for (const f of [20, 1000, 20000]) {
  const w = 2*Math.PI*f/sr;
  const hp = mag(hpProto(20,sr), w);
  const lm = mag(peakProto(400,0,decrampedQ(1,400,sr),sr), w);
  const hm = mag(peakProto(2500,0,decrampedQ(1,2500,sr),sr), w);
  const ls = mag(lpProto(120,sr), w);
  const hs = mag(lpProto(6000,sr), w);
  const lp = mag(lpProto(20000,sr), w);
  console.log(f+" Hz: hp="+db(hp).toFixed(3)+" lowMid="+db(lm).toFixed(3)+" highMid="+db(hm).toFixed(3)+" total="+db(hp*lm*hm*lp).toFixed(3));
}
