/* Shared by the browser and the server: every answer option the tablet offers.
   Labels in SKILLS and ROLES must match the Lists tab of the jobs Excel template. */
(function (root) {
  const SKILLS = [
    { id: "genai", label: "GenAI & LLMs", short: "GenAI & LLMs" },
    { id: "ml", label: "Data science & ML", short: "Data science & ML" },
    { id: "data", label: "Data engineering & analytics", short: "Data eng. & analytics" },
    { id: "cloud", label: "Cloud & DevOps", short: "Cloud & DevOps" },
    { id: "security", label: "Cybersecurity", short: "Cybersecurity" },
    { id: "backend", label: "Backend (Java, Python, Go…)", short: "Backend" },
    { id: "frontend", label: "Frontend & full-stack", short: "Frontend & full-stack" },
    { id: "mobile", label: "Mobile apps", short: "Mobile apps" },
    { id: "qa", label: "QA & test automation", short: "QA & testing" },
    { id: "product", label: "Product & UX design", short: "Product & UX" },
    { id: "biz", label: "Sales, marketing & ops", short: "Sales, mktg & ops" },
    { id: "othernt", label: "Other non-tech skills", short: "Other non-tech" }
  ];
  const EXP = [
    { id: "f", label: "Fresher / student", short: "Freshers", min: 0, max: 0 },
    { id: "e1", label: "1–2 years", short: "1–2 yrs", min: 1, max: 2 },
    { id: "e3", label: "3–5 years", short: "3–5 yrs", min: 3, max: 5 },
    { id: "e6", label: "6–9 years", short: "6–9 yrs", min: 6, max: 9 },
    { id: "e10", label: "10+ years", short: "10+ yrs", min: 10, max: 60 }
  ];
  const MODES = [
    { id: "online", label: "Online courses (Coursera, Udemy…)", short: "Online courses" },
    { id: "cert", label: "Certifications (AWS, Azure, Google…)", short: "Certifications" },
    { id: "bootcamp", label: "Bootcamp or training institute", short: "Bootcamp / institute" },
    { id: "job", label: "On-the-job or company training", short: "On-the-job" },
    { id: "college", label: "College or degree program", short: "College / degree" },
    { id: "self", label: "Self-taught (YouTube, side projects)", short: "Self-taught" },
    { id: "none", label: "Not training right now", short: "Not training now" }
  ];
  const ROLES = [
    { id: "backend", label: "Software / Backend engineers", short: "Backend engineers" },
    { id: "fullstack", label: "Frontend / Full-stack engineers", short: "Full-stack engineers" },
    { id: "data", label: "Data & AI / ML", short: "Data & AI/ML" },
    { id: "cloud", label: "DevOps / Cloud / SRE", short: "DevOps & Cloud" },
    { id: "security", label: "Cybersecurity", short: "Cybersecurity" },
    { id: "qa", label: "QA / Testing", short: "QA & Testing" },
    { id: "product", label: "Product / Design", short: "Product & Design" },
    { id: "fresher", label: "Freshers & interns", short: "Freshers & interns" },
    { id: "biz", label: "Sales / Ops / Non-tech", short: "Non-tech" }
  ];
  const PAIN = [
    { id: "volume", label: "Too many applicants to screen", short: "Screening volume" },
    { id: "quality", label: "Few candidates with the right skills", short: "Skill mismatch" },
    { id: "slow", label: "Slow time-to-hire", short: "Slow time-to-hire" },
    { id: "dropoff", label: "No-shows & offer drop-offs", short: "No-shows & drop-offs" },
    { id: "bandwidth", label: "Interviewer bandwidth", short: "Interviewer bandwidth" },
    { id: "cost", label: "High cost per hire", short: "Cost per hire" },
    { id: "fake", label: "Fake or inflated resumes", short: "Fake resumes" }
  ];
  const FLOWS = {
    c: [
      { key: "contact", type: "contact", q: "Let's find jobs that match you" },
      { key: "exp", q: "How much work experience do you have?", opts: "EXP", multi: 1 },
      { key: "have", q: "What are your strongest skills?", opts: "SKILLS", multi: 3 },
      { key: "train", q: "Are you training in a new skill right now?", opts: "SKILLS", multi: 1, optional: true, skip: "Not right now" }
    ],
    h: [
      { key: "roles", q: "Which roles are you hiring for?", opts: "ROLES", multi: 3 },
      { key: "need", q: "Which skills are hardest to find?", opts: "SKILLS", multi: 3 },
      { key: "pain", q: "What are your biggest hiring pain points?", opts: "PAIN", multi: 2 }
    ]
  };
  /* Contact rules, shared so the browser and server agree. */
  function normPhone(v) {
    let d = String(v || "").replace(/[\s\-().]/g, "");
    if (/^[6-9]\d{9}$/.test(d)) return "+91" + d;
    if (/^0[6-9]\d{9}$/.test(d)) return "+91" + d.slice(1);
    if (/^91[6-9]\d{9}$/.test(d)) return "+" + d;
    if (/^\+\d{8,15}$/.test(d)) return d;
    return null;
  }
  function normEmail(v) {
    const e = String(v || "").trim().toLowerCase();
    return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
  }
  function normName(v) {
    const n = String(v || "").replace(/\s+/g, " ").trim();
    return n.length >= 2 && n.length <= 60 && /\p{L}/u.test(n) ? n : null;
  }
  const Q = { SKILLS, EXP, MODES, ROLES, PAIN, FLOWS, normPhone, normEmail, normName };
  if (typeof module === "object" && module.exports) module.exports = Q;
  else root.PULSE_Q = Q;
})(typeof self !== "undefined" ? self : this);
