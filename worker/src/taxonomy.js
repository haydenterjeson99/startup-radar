/* ============================================================
   taxonomy.js — what we measure
   ------------------------------------------------------------
   Every theme, tool and gap is a named keyword set matched against
   a company's pitch, the opening of its long description, and its
   tags. This measures how founders describe themselves, which is
   the point — but it slightly undercounts companies that avoid the
   common vocabulary. Patterns use word boundaries so "agent" does
   not swallow "agency".
   ============================================================ */

const w = (...words) => words.map(s =>
  new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?([^a-z0-9]|$)`, 'i')
);

/* ---- Themes: the structural story of a batch ---- */
export const THEMES = [
  { id:'robotics', label:'Robotics & physical AI',
    blurb:'Not usually building a robot — building the layer that makes someone else\'s robot work. The wedge is a job humans dislike or cannot safely do.',
    kw: w('robot','robotic','robotics','humanoid','teleoperation','manipulation','actuator') },

  { id:'buildout', label:'Picks & shovels for the AI buildout',
    blurb:'Reading the AI capex cycle as the market rather than the tailwind — concrete, switching fabric, wafers and megawatts, not "cloud for AI".',
    kw: w('data center','datacenter','data centre','semiconductor','wafer','fab','grid','substation','megawatt','nuclear','interconnect') },

  { id:'ainative', label:'Become the firm, don\'t sell the software',
    blurb:'Rather than selling a tool to an accounting firm, be the accounting firm. The pitch is an outcome and a margin structure, not a seat licence.',
    kw: w('ai-native','ai native','agent-native','we are the firm','replace the','in-house team','done-for-you','managed service','bpo') },

  { id:'agentinfra', label:'Agent infrastructure & plumbing',
    blurb:'The boring layer an agent needs before it can be trusted in production — identity, payments, sandboxes, permissions, observability, context.',
    kw: w('agent infrastructure','agent identity','sandbox','observability','tracing','permission','guardrail','orchestration','mcp','tool call','context window') },

  { id:'corpus', label:'Proprietary data & evals as the product',
    blurb:'Public internet data is exhausted, so a visible slice of every batch exists to manufacture the next training corpus. The buyer list is short.',
    kw: w('eval','evals','benchmark','training data','world model','proprietary data','data vendor','post-training','reinforcement learning','rlhf','simulation') },

  { id:'defense', label:'Defense, drones & reshoring',
    blurb:'Defense plus a supply-chain sovereignty theme — American-made PCBs, magnetics and robots — that barely appeared two years ago.',
    kw: w('defense','defence','drone','counter-drone','uas','military','munition','radar','sovereign','reshoring','american-made','domestically manufactured') },

  { id:'legacy', label:'The unglamorous middle of the economy',
    blurb:'Industries where the incumbent software is twenty years old and the workflow still runs on phone calls, PDFs and spreadsheets.',
    kw: w('supply chain','freight','logistics','procurement','construction','roofing','hvac','property management','insurance','accounting','claims','distributor','field service','back office','restaurant','trucking') },
];

/* ---- Tools: the recurring building blocks ---- */
export const TOOLS = [
  { id:'inference', label:'Inference cost arbitrage',
    note:'Routing, caching, compression and model-mixing to cut token spend.',
    kw: w('inference','token','gpu','model routing','quantization','distillation','cost per call') },
  { id:'rl', label:'RL & post-training',
    note:'Increasingly aimed at robots and domain models rather than chat quality.',
    kw: w('reinforcement learning','post-training','fine-tun','rlhf','reward model') },
  { id:'worldmodel', label:'World models & simulation',
    note:'Simulate a factory, a freight network or a firmware stack cheaply enough to train against it.',
    kw: w('world model','simulation','simulator','digital twin','synthetic environment') },
  { id:'computeruse', label:'Computer-use agents',
    note:'Agents that drive real software, plus the data and benchmarks that feed them.',
    kw: w('computer use','computer-use','browser agent','screen recording','desktop agent','rpa') },
  { id:'voice', label:'Voice as the interface',
    note:'Mostly infrastructure now — the plumbing rather than the assistant.',
    kw: w('voice','speech','call','telephony','transcription','asr') },
  { id:'oss', label:'Open source as go-to-market',
    note:'Used to seed a standard where nobody trusts a black box yet.',
    kw: w('open source','open-source','oss','self-host','apache','mit licen') },
  { id:'ondevice', label:'On-device & private context',
    note:'The enterprise objection to agents, productised.',
    kw: w('on-device','on device','edge','local-first','privacy-preserving','air-gapped','runs locally') },
  { id:'vision', label:'Vision on cheap cameras',
    note:'The unlock is cost, not accuracy.',
    kw: w('computer vision','camera','image recognition','visual inspection','lidar','photogrammetry','satellite','earth observation') },
];

/* ---- Gaps: claimed problem -> what the batch builds in response ---- */
export const GAPS = [
  { n:1, problem:'Agents demo well and fail in production',
    response:'Not better models but operational scaffolding: evals, tracing, sandboxes, permissions, spend attribution, rollback.',
    kw: w('reliability','production-ready','hallucination','guardrail','eval','tracing','observability','audit trail') },
  { n:2, problem:'Inference is too expensive to run a business on',
    response:'Route to the cheapest adequate model, compress tool calls, and hedge compute like a commodity.',
    kw: w('cost','expensive','cheaper','token','inference','margin','spend') },
  { n:3, problem:'Compute is bottlenecked on power and concrete',
    response:'Faster data-center siting and construction, new generation including nuclear, and chips designed for a single model.',
    kw: w('power','energy','grid','data center','datacenter','megawatt','nuclear','cooling','permitting') },
  { n:4, problem:'Robots can\'t be taught without an army of engineers',
    response:'Post-training layers, teleoperation-as-data-collection, SDKs and real-world benchmarks — the tooling that made software robotics tractable, rebuilt for atoms.',
    kw: w('robot','teleoperation','demonstration','sdk','post-training','dexterity','manipulation') },
  { n:5, problem:'Professional services can\'t scale past headcount',
    response:'Buy or found the firm and run it with a fraction of the staff — capture the whole services margin instead of a software line item.',
    kw: w('firm','practice','agency','consultant','headcount','billable','staffing','ai-native') },
  { n:6, problem:'The physical economy runs on stale software',
    response:'One system of record per trade, with the agent doing the data entry that killed adoption of the last generation of tools.',
    kw: w('legacy','outdated','spreadsheet','pen and paper','phone call','fax','manual process','system of record','operating system for') },
  { n:7, problem:'Labs have run out of internet to train on',
    response:'Manufacture proprietary corpora — industrial telemetry, robot trajectories, expert judgement — and sell to a customer list of five.',
    kw: w('training data','proprietary data','data collection','corpus','frontier lab','data vendor','annotation','labeling') },
  { n:8, problem:'Defense supply chains are fragile and foreign',
    response:'Domestically manufactured drones, magnetics, PCBs and aerospace parts. Sovereignty as a product claim, not a policy talking point.',
    kw: w('supply chain','sovereign','domestic','reshoring','american-made','tariff','export control','critical mineral') },
];

/* YC's own industry taxonomy — applied consistently across batches,
   which is what makes cross-batch comparison trustworthy. */
export const INDUSTRIES = [
  'Industrials','Infrastructure','Healthcare','Fintech','Consumer',
  'B2B','Education','Government','Real Estate and Construction','Unspecified',
];
