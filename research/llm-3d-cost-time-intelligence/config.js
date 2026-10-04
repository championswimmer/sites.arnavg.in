// Setup for the cost / intelligence / time viewer. Edit this file to change data, colours, axes and defaults.
// Loaded by index.html before the rendering code.
window.LLM3D_CONFIG={

// Time metrics. kind "tok": axis = s per 1K output tokens (1000 / tok/s), threshold slider = min tok/s.
// kind "task": axis = seconds per task (AA), threshold slider = max seconds.
// tmax = time axis max, tstep = grid spacing, limit = default threshold, smin/smax/sstep = slider range.
sources:{aa:"AA chart",p50:"OpenRouter p50",p90:"OpenRouter p90",task:"AA time per task"},
modes:{
  aa:{kind:"tok",tmax:30,tstep:5,limit:100,smin:30,smax:240,sstep:5},
  p50:{kind:"tok",tmax:35,tstep:5,limit:60,smin:30,smax:240,sstep:5},
  p90:{kind:"tok",tmax:25,tstep:5,limit:100,smin:30,smax:240,sstep:5},
  task:{kind:"task",tmax:2500,tstep:500,limit:1000,smin:100,smax:2500,sstep:50}
},
defaultMode:"p90",

// Cost metrics (log axis). cmin/cmax = axis range, ticks = grid lines, limit = default max-cost threshold.
costModes:{
  task:{label:"Cost per task (AA)",axis:"Cost per task (USD, log)",cmin:0.04,cmax:12,ticks:[0.05,0.1,0.2,0.5,1,2,5,10],limit:2},
  mtok:{label:"$ per M tokens (OpenRouter, blended)",axis:"Blended price, USD per M tokens (log)",cmin:0.1,cmax:30,ticks:[0.1,0.2,0.5,1,2,5,10,20],limit:3}
},
defaultCostMode:"task",
blendInputWeight:3, // $/M blend = (w*input + output) / (w+1); 3 = AA's 3:1 convention

// Provider colours
colors:{
Anthropic:"#c4704f",OpenAI:"#6b7280",Meta:"#2f7cf6",Xiaomi:"#f97316",Alibaba:"#e8590c",Kimi:"#3b5bdb",
"Z AI":"#0ea5e9",SpaceXAI:"#8b5cf6",StepFun:"#14b8a6",Google:"#22a35a",DeepSeek:"#1e3a8a",MiniMax:"#e11d6a",NVIDIA:"#84cc16",Mistral:"#f59e0b"
},

// Intelligence axis range and time axis minimum (cost/time maxima are per mode, above)
axes:{imin:10,imax:62,tmin:0},

// Default octant thresholds
thresholds:{iq:45}
};
