// Setup for the cost / intelligence / time viewer. Edit this file to change data, colours, axes and defaults.
// Loaded by index.html before the rendering code.
window.LLM3D_CONFIG={

// Speed source labels
sources:{aa:"AA chart",p50:"OpenRouter p50",p90:"OpenRouter p90"},

// Per-source defaults: tmax = time axis max (s per 1K tokens), speed = default minimum-speed threshold (tok/s)
modes:{aa:{tmax:30,speed:100},p50:{tmax:35,speed:60},p90:{tmax:25,speed:100}},
defaultMode:"p90",

// Provider colours
colors:{
Anthropic:"#c4704f",OpenAI:"#6b7280",Meta:"#2f7cf6",Xiaomi:"#f97316",Alibaba:"#e8590c",Kimi:"#3b5bdb",
"Z AI":"#0ea5e9",SpaceXAI:"#8b5cf6",StepFun:"#14b8a6",Google:"#22a35a",DeepSeek:"#1e3a8a",MiniMax:"#e11d6a",NVIDIA:"#84cc16",Mistral:"#f59e0b"
},

// Axis ranges (cost is log-scaled)
axes:{cmin:0.04,cmax:12,imin:10,imax:62,tmin:0,tmax:25},

// Default octant thresholds
thresholds:{iq:45,cost:2,speed:100}
};
