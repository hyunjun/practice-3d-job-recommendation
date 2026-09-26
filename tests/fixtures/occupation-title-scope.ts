import type { Company, Job, JobOccupation, KnownJobRole, SavedJob } from '../../shared/types'

// Entirely fictional. These job descriptions are authored for the regression;
// no collected company description is copied into this public-test candidate.
export const SCOPE_TIME = '2026-09-26T07:00:00.000Z'
export const SCOPE_NEXT_TIME = '2026-09-26T07:02:00.000Z'
export const SCOPE_SAVED_AT = '2026-09-25T09:15:00.000Z'
export const SCOPE_COMPANY: Company = {
  id: 'fable-orbit', name: 'Fable Orbit Studio', initials: 'FO', color: '#84dba6',
  industry: 'Fictional tools and vehicles', provider: 'greenhouse', board: 'fable-orbit',
  careerUrl: 'https://example.org/fable-orbit/careers',
}

export interface ScopeCase {
  key: string
  title: string
  description: string
  departments: string[]
  expectedCategory: JobOccupation['category']
  expectedExplorable: boolean
  expectedRoles: KnownJobRole[]
}

// Categories, exploration eligibility and specialties are independent oracles.
// Do not replace these literals with occupationFacts, isTechnicalJob or a regex.
export const OUTSIDE_SCOPE_CASES: ScopeCase[] = [
  {
    key: 'designer', title: 'Senior Product Designer, Developer Success',
    description: 'Responsibilities\nCreate page layouts and clickable storyboards for our fictional partner portal. Review typography and interaction patterns with the design team.\nRequirements\nA portfolio of interface design and experience using prototyping tools.',
    departments: ['Product Design'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'administrator', title: 'Administrative Business Partner - Engineering, Product and Design',
    description: 'Responsibilities\nArrange executive calendars, reserve meeting rooms and reconcile travel receipts for the engineering division.\nRequirements\nExperience coordinating office schedules and confidential correspondence.',
    departments: ['Core Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'assistant', title: 'Executive Assistant, Software Engineering',
    description: 'Responsibilities\nPrepare meeting agendas, book rail tickets and process expense forms for software leadership.\nRequirements\nExperience supporting executive schedules.',
    departments: ['Software Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'community', title: 'Developer Engagement Representative - Northern Region (Part-Time Contract)',
    description: 'Responsibilities\nCoordinate community meetups, translate event invitations and maintain relationships with local creators.\nRequirements\nExperience in community outreach and event logistics.',
    departments: ['Developer Relations (Non-Tech)'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'aerodynamics', title: 'Aerodynamics Engineer (Nimbus Vehicle)',
    description: 'Responsibilities\nEvaluate air loads on vehicle fins using wind-tunnel measurements and fluid-flow simulations. Recommend changes to the airframe geometry. Use a short Python script to plot wind-tunnel readings.\nRequirements\nExperience with compressible flow and aerodynamic testing.',
    departments: ['Flight Analysis'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'ams', title: 'AMS Verification Engineer (RFIC Engineering)',
    description: 'Responsibilities\nVerify phase-locked loops and analog converter circuits with mixed-signal testbenches. Check voltage margins and chip-level circuit behavior.\nRequirements\nExperience in integrated-circuit verification. Use SystemVerilog and Python to inspect circuit simulation results.',
    departments: ['RFIC Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'actuator', title: 'Actuator Design Engineer',
    description: 'Responsibilities\nDimension gear assemblies, select bearings and validate torque and thermal tolerances of robotic joints.\nRequirements\nExperience with electromechanical assemblies and mechanical drawings.',
    departments: ['Robotics'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'propulsion', title: 'Propulsion Engineer',
    description: 'Responsibilities\nSize fuel injectors and pressure vessels. Plan combustion-chamber tests and inspect nozzle erosion after firing.\nRequirements\nExperience with rocket propulsion and thermodynamics.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
]

export const TECHNICAL_SCOPE_CASES: ScopeCase[] = [
  {
    key: 'designer-tools', title: 'Software Engineer, Product Designer Tools',
    description: 'Responsibilities\nBuild production software services and versioned APIs for a fictional page-layout editor.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Product Design'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'designer-audience', title: 'Software Engineer for Product Designers',
    description: 'Responsibilities\nImplement collaborative editing software and maintain automated release tests.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Design'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'frontend-community', title: 'Frontend Engineer, Developer Community',
    description: 'Responsibilities\nDevelop production web software for a fictional community portal and test its accessibility.\nRequirements\nExperience with TypeScript and frontend software development.',
    departments: ['Developer Relations (Non-Tech)'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['frontend'],
  },
  {
    key: 'backend-administration', title: 'Backend Developer, Administrative Tools',
    description: 'Responsibilities\nImplement backend software services and audit-log APIs for fictional scheduling tools.\nRequirements\nExperience with TypeScript and backend software development.',
    departments: ['Business Operations'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['backend'],
  },
  {
    key: 'firmware', title: 'Firmware Engineer, RF Hardware',
    description: 'Responsibilities\nWrite production firmware and device drivers for embedded radio controllers.\nRequirements\nExperience with C and real-time software development.',
    departments: ['Hardware'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'embedded', title: 'Embedded Software Engineer, Flight Controls',
    description: 'Responsibilities\nImplement embedded software, scheduler code and safety-monitoring tests for a fictional flight computer.\nRequirements\nExperience with C and embedded software development.',
    departments: ['Flight Systems'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'ml-aerodynamics', title: 'Machine Learning Engineer, Aerodynamic Predictions',
    description: 'Responsibilities\nTrain machine learning models and deploy inference software for an experimental simulation service.\nRequirements\nExperience with Python and machine learning systems.',
    departments: ['Flight Analysis'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['ml'],
  },
  {
    key: 'hardware-security', title: 'Offensive Hardware Security Engineer',
    description: 'Responsibilities\nDevelop security analysis software and reverse-engineer firmware to find exploitable vulnerabilities.\nRequirements\nExperience with computer security and low-level software.',
    departments: ['Hardware'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['security'],
  },
  {
    key: 'design-computing', title: 'Design Engineer',
    description: 'Responsibilities\nBuild backend software services and APIs for a fictional design editor. Maintain deployment pipelines and implement code-generation tools.\nRequirements\nExperience with TypeScript and software engineering.',
    departments: ['UI/UX'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'technical-research', title: 'Research Scientist, Machine Learning for Chip Design',
    description: 'Responsibilities\nResearch machine learning algorithms and evaluate neural networks for a fictional placement benchmark.\nRequirements\nExperience with Python and machine learning research.',
    departments: ['Hardware Research'],
    expectedCategory: 'research', expectedExplorable: true, expectedRoles: ['ml'],
  },
  {
    key: 'aerodynamics-software', title: 'Software Engineer, Aerodynamics Simulation Tools',
    description: 'Responsibilities\nDevelop simulation software and maintain distributed job scheduling APIs for a fictional wind-tunnel service.\nRequirements\nExperience with software engineering and TypeScript.',
    departments: ['Flight Analysis'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'asic-firmware', title: 'ASIC Firmware Engineer, Robotics',
    description: 'Responsibilities\nImplement firmware drivers and functional software models for a fictional robot controller.\nRequirements\nExperience with embedded software development.',
    departments: ['Hardware', 'Robotics'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
]

export const FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE: ScopeCase = {
  key: 'flight-software-infrastructure', title: 'Flight Software Infrastructure Engineer',
  description: 'Responsibilities\nImplement build orchestration software and code-generation tools for a fictional flight computer. Maintain deployment services and automated software regression tests.\nRequirements\nExperience with Python, C++ and software infrastructure.',
  departments: ['Flight Software'],
  expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['devops'],
}

// Additional primary-role boundaries and explicit computing controls.
export const CONFIRMED_EXTRA_SCOPE_CASES: ScopeCase[] = [
  {
    key: 'engineering-coordinator', title: 'Engineering Program Coordinator',
    description: 'Responsibilities\nMaintain meeting schedules, reserve training rooms and track attendance for the fictional engineering programme.\nRequirements\nExperience with event administration and office scheduling.',
    departments: ['Engineering Operations'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'developer-coordinator', title: 'Developer Community Coordinator',
    description: 'Responsibilities\nSchedule community sessions, distribute invitations and arrange venues for local creators.\nRequirements\nExperience coordinating events and community communications.',
    departments: ['Community'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'developer-representative', title: 'Developer Relations Representative',
    description: 'Responsibilities\nMaintain creator contacts, welcome event participants and distribute programme announcements.\nRequirements\nExperience with outreach and community engagement.',
    departments: ['Community'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'analog-circuit', title: 'Analog Circuit Design Engineer',
    description: 'Responsibilities\nDesign amplifier bias circuits, select passive components and measure voltage drift on laboratory boards.\nRequirements\nExperience with analog circuit analysis and bench instruments.',
    departments: ['Circuit Design'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'rfic-design', title: 'RFIC Design Engineer',
    description: 'Responsibilities\nDesign radio-frequency integrated circuits and verify oscillator noise and amplifier gain with circuit simulation tools.\nRequirements\nExperience with transistor-level circuit design and radio-frequency measurements.',
    departments: ['Circuit Design'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'rfic-ai-product', title: 'RFIC Engineer, AI Satellite Products',
    description: 'Responsibilities\nDesign analog radio circuits and specify transistor-level amplifier components for a fictional satellite product.\nRequirements\nExperience with RF circuit design and analog bench measurements.',
    departments: ['Circuit Design'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'coordinator-tools', title: 'Software Engineer, Coordinator Tools',
    description: 'Responsibilities\nBuild production software services and scheduling APIs used by fictional event coordinators.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Operations'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'assistant-tools', title: 'Software Engineer, Assistant Tools',
    description: 'Responsibilities\nImplement application software and automated tests for a fictional calendar assistant product.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Operations'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'representative-console', title: 'Software Engineer, Representative Console',
    description: 'Responsibilities\nImplement application software and document APIs for a fictional outreach console.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Community'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'data-circuit', title: 'Data Engineer, RF Circuit Analytics',
    description: 'Responsibilities\nBuild data pipelines and maintain warehouse software for a fictional circuit telemetry service.\nRequirements\nExperience with Python and data engineering.',
    departments: ['Hardware'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['data'],
  },
  {
    key: 'firmware-actuator', title: 'Firmware Engineer, Actuator Controller',
    description: 'Responsibilities\nImplement production firmware and device-driver tests for a fictional robotic joint controller.\nRequirements\nExperience with C and embedded software development.',
    departments: ['Robotics'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'embedded-propulsion', title: 'Embedded Developer, Propulsion Controls',
    description: 'Responsibilities\nWrite embedded software and scheduler tests for a fictional propulsion controller.\nRequirements\nExperience with real-time software and C.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'ai-propulsion', title: 'AI Research Scientist, Propulsion Models',
    description: 'Responsibilities\nResearch neural-network algorithms and evaluate machine learning models for a fictional simulation benchmark.\nRequirements\nExperience with Python and machine learning research.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'research', expectedExplorable: true, expectedRoles: ['ml'],
  },
  {
    key: 'software-circuit', title: 'Software Engineer, RF Circuit Simulation',
    description: 'Responsibilities\nDevelop simulation software and maintain distributed execution services for a fictional circuit modelling product.\nRequirements\nExperience with TypeScript and software development.',
    departments: ['Circuit Design'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  FLIGHT_SOFTWARE_INFRASTRUCTURE_CASE,
  {
    key: 'software-infrastructure-flight', title: 'Software Infrastructure Engineer, Flight Software',
    description: 'Responsibilities\nDevelop build orchestration software and release automation for fictional flight applications.\nRequirements\nExperience with software infrastructure and Python.',
    departments: ['Flight Software'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['devops'],
  },
  {
    key: 'flight-software-systems', title: 'Flight Software Systems Engineer',
    description: 'Responsibilities\nImplement software components and message-routing protocols for a fictional flight computer.\nRequirements\nExperience with C++ and software systems development.',
    departments: ['Avionics'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'avionics-software-development', title: 'Avionics Software Development Engineer',
    description: 'Responsibilities\nImplement device-interface software and automated unit tests for a fictional avionics simulator.\nRequirements\nExperience with C++ and software development.',
    departments: ['Avionics'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'thermal-software-test', title: 'Thermal Software Test Engineer',
    description: 'Responsibilities\nWrite automated software tests and develop a regression harness for a fictional thermal simulation application.\nRequirements\nExperience with Python and software test development.',
    departments: ['Thermal Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'software-development-test', title: 'Software Development Test Engineer, RFIC Tools',
    description: 'Responsibilities\nDevelop test software and continuous-integration jobs for a fictional design-tools application. Implement software test fixtures for emulated devices.\nRequirements\nExperience with Python and software test development.',
    departments: ['RFIC Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'pcb-software-test', title: 'Software Test Engineer, PCB Validation Tools',
    description: 'Responsibilities\nImplement automated software tests and improve test-runner code for a fictional board inspection application.\nRequirements\nExperience with Python and software development.',
    departments: ['PCB Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'materials-software-systems', title: 'Software Systems Engineer, Materials Modelling',
    description: 'Responsibilities\nDevelop software services and maintain a numerical solver application for a fictional materials analysis platform.\nRequirements\nExperience with C++ and software systems.',
    departments: ['Materials Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'eda-computing', title: 'EDA Engineer (RFIC Engineering)',
    description: 'Responsibilities\nDevelop production software services for scheduling circuit-tool jobs. Own the Python application source, its command-line API and automated regression tests.\nRequirements\nExperience with software development, Linux and distributed job execution.',
    departments: ['RFIC Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'materials-data-scientist', title: 'Data Scientist, Materials Modelling',
    description: 'Responsibilities\nDevelop statistical learning algorithms and data-processing software for a fictional materials prediction service.\nRequirements\nExperience with Python and data science.',
    departments: ['Materials Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['data'],
  },
  {
    key: 'antenna-security-research', title: 'Security Researcher, Antenna Systems',
    description: 'Responsibilities\nResearch cryptographic protocols and develop software that tests vulnerabilities in fictional radio firmware.\nRequirements\nExperience with computer security and cryptography.',
    departments: ['Antenna Engineering'],
    expectedCategory: 'research', expectedExplorable: true, expectedRoles: ['security'],
  },
  {
    key: 'ai-antenna', title: 'AI Engineer, Antenna Models',
    description: 'Responsibilities\nImplement model-training software and deploy neural-network inference for a fictional antenna prediction service.\nRequirements\nExperience with Python and AI systems.',
    departments: ['Antenna Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['ml'],
  },
  {
    key: 'ml-flight', title: 'ML Engineer, Flight Models',
    description: 'Responsibilities\nBuild machine learning software and evaluate prediction models for a fictional flight-planning application.\nRequirements\nExperience with Python and machine learning systems.',
    departments: ['Flight Engineering'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: ['ml'],
  },
  {
    key: 'computer-avionics', title: 'Computer Engineer, Avionics Simulation Tools',
    description: 'Responsibilities\nImplement software emulators and develop operating-system services for a fictional avionics test environment.\nRequirements\nExperience with computer systems and C++ software development.',
    departments: ['Avionics'],
    expectedCategory: 'engineering', expectedExplorable: true, expectedRoles: [],
  },
  {
    key: 'flight-test', title: 'Flight Test Engineer',
    description: 'Responsibilities\nPlan airframe flight trials, measure stability limits and inspect structural loads after each test flight.\nRequirements\nExperience with flight-test instrumentation and aircraft certification.',
    departments: ['Flight Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'avionics-hardware', title: 'Avionics Engineer',
    description: 'Responsibilities\nDesign instrument wiring and circuit-board assemblies. Qualify power supplies and connectors using bench measurements.\nRequirements\nExperience with aircraft electrical assemblies.',
    departments: ['Avionics'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'fluid-systems', title: 'Fluid Systems Engineer',
    description: 'Responsibilities\nSize hydraulic pipes and pressure regulators. Inspect coolant leaks and qualify fluid-system pressure limits.\nRequirements\nExperience with hydraulic systems and pressure testing.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'thermal-hardware', title: 'Thermal Engineer',
    description: 'Responsibilities\nDesign heat sinks and insulation assemblies. Evaluate physical heat transfer using chamber measurements.\nRequirements\nExperience with thermal testing and heat-transfer analysis.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'antenna-hardware', title: 'Antenna Engineer',
    description: 'Responsibilities\nDesign antenna geometry and tune radio matching circuits. Measure antenna gain and radiation patterns.\nRequirements\nExperience with electromagnetic analysis and antenna test equipment.',
    departments: ['Radio Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'launch-hardware', title: 'Launch Engineer',
    description: 'Responsibilities\nQualify launch-pad fixtures, inspect fueling equipment and prepare physical ground-support procedures.\nRequirements\nExperience with launch-site equipment and pressure-system operation.',
    departments: ['Launch Operations'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'materials-hardware', title: 'Materials Engineer',
    description: 'Responsibilities\nEvaluate alloy strength, inspect fractured metal samples and define heat-treatment procedures.\nRequirements\nExperience with metallurgy and physical materials testing.',
    departments: ['Materials Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'pcb-hardware', title: 'PCB Design Engineer',
    description: 'Responsibilities\nLay out physical circuit-board traces, select laminate materials and verify electrical clearance.\nRequirements\nExperience with printed circuit-board layout and fabrication.',
    departments: ['Circuit Design'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'structures-hardware', title: 'Structures Engineer',
    description: 'Responsibilities\nSize load-bearing vehicle frames and qualify joints using static-load and fatigue tests.\nRequirements\nExperience with structural analysis and physical frame testing.',
    departments: ['Vehicle Engineering'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
  {
    key: 'welding-hardware', title: 'Welding Engineer',
    description: 'Responsibilities\nDevelop welding procedures and inspect joint quality. Qualify weld processes with destructive specimen testing.\nRequirements\nExperience with welding metallurgy and fabrication standards.',
    departments: ['Fabrication'],
    expectedCategory: 'other', expectedExplorable: false, expectedRoles: [],
  },
]

/** Input construction only; deliberately does not call production classifiers. */
export function scopeJob(fixture: ScopeCase, overrides: Partial<Job> = {}): Job {
  return {
    id: `greenhouse-fable-orbit-${fixture.key}`, companyId: 'fable-orbit',
    title: fixture.title, description: fixture.description, role: 'unknown',
    cityIds: ['london'], locationLabel: 'London, UK', workMode: 'onsite', employment: 'fulltime',
    minExperience: null, skills: ['TypeScript'], salary: null, visa: 'unknown',
    remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
    source: 'greenhouse', requirements: [], updatedAt: null, fetchedAt: SCOPE_TIME,
    url: `https://example.org/fable-orbit/${fixture.key}`, ...overrides,
  }
}

/** Known historical mistake, authored literally rather than generated by a parser. */
export function legacyScopeJob(fixture: ScopeCase = OUTSIDE_SCOPE_CASES[1], version: 1 | 2 | 3 = 3): Job {
  return scopeJob(fixture, {
    role: 'devops',
    roleClassification: {
      version: 1, roles: ['devops'],
      evidence: [{ role: 'devops', source: 'board', text: 'Infrastructure' }],
    },
    occupation: {
      version, category: 'engineering',
      evidence: [{ source: 'title', text: fixture.title }],
      departments: fixture.departments,
    },
  })
}

export function legacyScopeSaved(version: 1 | 2 | 3 = 3): SavedJob {
  return {
    job: legacyScopeJob(OUTSIDE_SCOPE_CASES[1], version), company: SCOPE_COMPANY,
    savedAt: SCOPE_SAVED_AT, status: 'applied', note: 'Fictional note: confirm the office schedule.',
  }
}
