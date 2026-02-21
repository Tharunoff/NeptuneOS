// NeptuneOS Geospatial Subsea Simulation (WGS84)

// --------------------------------------------------------
// 1. SCENE SETUP & THREE.JS CONFIG
// --------------------------------------------------------
const R_EARTH = 6371; // km
const MAX_LENGTH = 1900; // km

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020813);
scene.fog = new THREE.FogExp2(0x020813, 0.0005); // Global deep fog

// Logarithmic depth buffer is critical for planetary scale
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 50000);
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('canvas-container').appendChild(renderer.domElement);

// Lights
const ambientLight = new THREE.AmbientLight(0x404040, 0.6); // Soft white light
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(R_EARTH * 1.5, R_EARTH * 1.5, R_EARTH * 1.5);
scene.add(dirLight);

// --------------------------------------------------------
// 2. WGS84 & BATHYMETRY MATH UTILS
// --------------------------------------------------------
const START_LAT = 22.8390;
const START_LON = 69.7210; // Mundra
const END_LAT = 25.1288;
const END_LON = 56.3265;   // Fujairah

function latLonToVector3(lat, lon, depthKm = 0) {
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lon + 180) * (Math.PI / 180);
    const r = R_EARTH - depthKm;

    const x = -(r * Math.sin(phi) * Math.cos(theta));
    const z = (r * Math.sin(phi) * Math.sin(theta));
    const y = (r * Math.cos(phi));

    return new THREE.Vector3(x, y, z);
}

// Lerp between two coordinates based on parameter t (0 to 1)
function interpolateCoord(t) {
    return {
        lat: START_LAT + (END_LAT - START_LAT) * t,
        lon: START_LON + (END_LON - START_LON) * t
    };
}

// Approximate bathymetry depth profile in kilometers based on KP
function getDepthKmAtKP(kp) {
    // Smooth transitions between sectors using cosine interpolation
    let targetDepthM = 0;

    if (kp <= 350) {
        // India coastal shelf (20-60m)
        targetDepthM = 20 + (kp / 350) * 40;
    } else if (kp <= 1100) {
        // Continental slope to Deep Basin (60 -> 4200)
        let localT = (kp - 350) / 750;
        targetDepthM = 60 + 4140 * Math.pow(localT, 1.5);
    } else if (kp <= 1550) {
        // Oman slope (4200 -> 800)
        let localT = (kp - 1100) / 450;
        targetDepthM = 4200 - 3400 * Math.sqrt(localT);
    } else {
        // UAE coast (800 -> 50)
        let localT = (kp - 1550) / 350;
        targetDepthM = 800 - 750 * Math.pow(localT, 0.8);
    }

    // Add slight undulations
    let undulation = Math.sin(kp * 0.1) * 15 + Math.cos(kp * 0.03) * 30;
    return (targetDepthM + undulation) / 1000.0; // Return in km
}

// Master curve points calculation
const CURVE_RESOLUTION = 200;
const masterPoints = [];
for (let i = 0; i <= CURVE_RESOLUTION; i++) {
    const t = i / CURVE_RESOLUTION;
    const kp = t * MAX_LENGTH;
    const coord = interpolateCoord(t);
    const depthKm = getDepthKmAtKP(kp);

    const pos = latLonToVector3(coord.lat, coord.lon, depthKm);
    masterPoints.push(pos);
}
const masterCurve = new THREE.CatmullRomCurve3(masterPoints);

// Generate Frenet Frames for offsetting (to place parallel lines)
const frames = masterCurve.computeFrenetFrames(CURVE_RESOLUTION, false);

// Utility to generate a parallel offset curve
function generateOffsetCurve(offsetX, offsetY) {
    const offsetPoints = [];
    for (let i = 0; i <= CURVE_RESOLUTION; i++) {
        const pt = masterPoints[i].clone();
        const normal = frames.normals[i].clone();
        const binormal = frames.binormals[i].clone();

        // Offset locally
        pt.add(normal.multiplyScalar(offsetX / 1000.0)); // Convert meters offset to km
        pt.add(binormal.multiplyScalar(offsetY / 1000.0));

        offsetPoints.push(pt);
    }
    return new THREE.CatmullRomCurve3(offsetPoints);
}

// --------------------------------------------------------
// 2.5. DIGITAL TWIN BACKEND STRUCTURES
// --------------------------------------------------------
class SensorCluster {
    constructor() {
        this.pressure = { baseline: 100.0, current: 100.0, noise: 0.5, drift: 0.01 };
        this.flow = { baseline: 50.0, current: 50.0, noise: 0.2, drift: 0.0 };
        this.acoustic = { baseline: 10.0, current: 10.0, noise: 2.0, drift: 0.0 };
        this.temperature = { baseline: 4.0, current: 4.0, noise: 0.1, drift: 0.001 };
        this.strain = { baseline: 0.0, current: 0.0, noise: 0.05, drift: 0.005 };
        this.tilt = { baseline: 0.0, current: 0.0, noise: 0.1, drift: 0.01 };
        this.timestamp_history = [Date.now()];
        this.confidence_score = 0.99;
    }
}

class SegmentNode {
    constructor(id, assetType, kpStart, kpEnd, lat, lon, depth, sectorId) {
        this.segment_id = id;
        this.asset_type = assetType;
        this.kp_start = kpStart;
        this.kp_end = kpEnd;
        this.latitude = lat;
        this.longitude = lon;
        this.depth = depth;
        this.sector_id = sectorId;
        this.health_state = "healthy";
        this.uncertainty_buffer = 0.0;
        this.sensor_cluster = new SensorCluster();
    }
}

class SectorDataNode {
    constructor(sectorId, kpRange, stationId) {
        this.sector_id = sectorId;
        this.kp_range = kpRange;
        this.stability_index = 100.0;
        this.aggregated_variance = 0.0;
        this.active_segments = 0;
        this.resident_station_id = stationId;
    }
}

// --------------------------------------------------------
// 2.6. HAZARD INJECTION ENGINE (PHASE 3)
// --------------------------------------------------------
const HAZARD_PROFILES = {
    'anchor_drag': { strain: 0.8, acoustic: 0.5, radius: 2, drift: 0.0, uncertainty_accel: 0.2 },
    'corrosion': { strain: 0.1, pressure: 0.05, radius: 1, drift: 0.02, uncertainty_accel: 0.05 },
    'gas_leak': { pressure: -0.2, acoustic: 0.6, temp: -0.4, radius: 3, drift: 0.05, uncertainty_accel: 0.15 },
    'crude_rupture': { pressure: -0.8, flow: -0.7, acoustic: 0.9, radius: 5, drift: 0.1, uncertainty_accel: 0.5 },
    'fiber_att': { flow: 0, strain: 0.1, radius: 1, drift: 0.05, uncertainty_accel: 0.1 }, // Fiber uses logical signal drop, mapped to strain here
    'landslide': { tilt: 0.9, strain: 0.7, radius: 8, drift: 0.01, uncertainty_accel: 0.4 },
    'turbine_crack': { acoustic: 0.4, strain: 0.3, radius: 2, drift: 0.03, uncertainty_accel: 0.1 },
    'marine_collision': { acoustic: 0.6, strain: 0.2, radius: 1, drift: 0.0, uncertainty_accel: 0.2 },
    'seismic': { acoustic: 0.5, tilt: 0.3, radius: 15, drift: -0.05, uncertainty_accel: 0.3 } // Negative drift means it resolves over time if no damage
};

class ActiveHazard {
    constructor(id, type, assetId, kpPos, severityStr) {
        this.id = id;
        this.type = type;
        this.assetId = assetId;
        this.kp = kpPos;

        const severityMult = { 'low': 0.5, 'medium': 1.0, 'high': 1.5, 'critical': 2.5 }[severityStr];
        this.profile = JSON.parse(JSON.stringify(HAZARD_PROFILES[type])); // clone

        // Scale impacts by severity
        for (let key in this.profile) {
            this.profile[key] *= severityMult;
        }

        this.startTime = Date.now();
        this.active = true;
    }
}

// --------------------------------------------------------
// 2.7. AUV PHYSICS & MISSION ENGINE (PHASE 5)
// --------------------------------------------------------
class AUVNode {
    constructor(id, homeStationKp) {
        this.id = id;
        this.home_kp = homeStationKp;
        this.current_kp = homeStationKp;
        this.target_kp = null;
        this.target_asset = null;

        // Physics State
        this.depth = getDepthKmAtKP(homeStationKp); // Starts at station depth
        this.velocity_horizontal = 0; // knots (1 knot = 0.5144 m/s)
        this.velocity_vertical = 0;   // m/s

        // Battery Math: 100 kWh battery = 360,000,000 Joules
        this.battery_max_joules = 360000000;
        this.battery_joules = this.battery_max_joules;
        this.base_power_watts = 500; // Hotel load (computers, basic sensors)

        // State Machine
        // IDLE -> UNDOCKING -> TRANSIT_VERTICAL -> TRANSIT_HORIZONTAL -> ON_SITE_SCAN -> REPORTING -> RETURN
        this.state = 'IDLE';
        this.scan_phase = 0;
        this.scan_timer = 0;
    }

    get battery_percent() {
        return (this.battery_joules / this.battery_max_joules) * 100;
    }
}

// Global state container
const digitalTwinDB = {
    assets: {
        'gas_a': [],
        'gas_b': [],
        'crude': [],
        'power': [],
        'fiber': []
    },
    active_hazards: [],
    active_auvs: [],
    sectors: {
        'A': new SectorDataNode('A', [0, 350], 'STATION_A'),
        'B': new SectorDataNode('B', [350, 1100], 'STATION_B'),
        'C': new SectorDataNode('C', [1100, 1550], 'STATION_C'),
        'D': new SectorDataNode('D', [1550, 1900], 'STATION_D')
    }
};

function determineSector(kp) {
    if (kp <= 350) return 'A';
    if (kp <= 1100) return 'B';
    if (kp <= 1550) return 'C';
    return 'D';
}

// --------------------------------------------------------
// 3. LAYER GROUPS & ASSET GENERATION
// --------------------------------------------------------
const assetMeshes = {}; // Store references to update vertex colors later

const layers = {
    gas: new THREE.Group(),
    crude: new THREE.Group(),
    power: new THREE.Group(),
    fiber: new THREE.Group(),
    sectors: new THREE.Group(),
    bathymetry: new THREE.Group(),
    stations: new THREE.Group()
};
Object.values(layers).forEach(g => scene.add(g));

// --- Bathymetry Terrain ---
// We generate a strip geometry representing the seabed corridor
const seabedWidthKm = 5.0; // 5km wide corridor
const seabedGeo = new THREE.PlaneGeometry(seabedWidthKm, MAX_LENGTH, 10, CURVE_RESOLUTION);
const posAttr = seabedGeo.attributes.position;
const seabedColors = [];
const colorObj = new THREE.Color();

for (let i = 0; i <= CURVE_RESOLUTION; i++) {
    const t = i / CURVE_RESOLUTION;
    const kp = t * MAX_LENGTH;
    const basePt = masterPoints[i];
    const normal = frames.normals[i];

    // Depth-based shading (darker in basin)
    const depthKm = getDepthKmAtKP(kp);
    const depthRatio = Math.min(depthKm / 4.2, 1.0); // 4.2km is max
    colorObj.setHSL(0.55, 0.4, 0.4 - (depthRatio * 0.35)); // Blue-green, darker at depth

    for (let w = 0; w <= 10; w++) {
        const rowOffset = (w / 10) - 0.5; // -0.5 to 0.5
        const currentPt = basePt.clone().add(normal.clone().multiplyScalar(rowOffset * seabedWidthKm));

        const idx = (i * 11 + w) * 3;
        posAttr.array[idx] = currentPt.x;
        posAttr.array[idx + 1] = currentPt.y;
        posAttr.array[idx + 2] = currentPt.z;

        seabedColors.push(colorObj.r, colorObj.g, colorObj.b);
    }
}
seabedGeo.setAttribute('color', new THREE.Float32BufferAttribute(seabedColors, 3));
seabedGeo.computeVertexNormals();

const seabedMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.1,
    side: THREE.DoubleSide,
    wireframe: false
});
const bathymetryMesh = new THREE.Mesh(seabedGeo, seabedMat);
layers.bathymetry.add(bathymetryMesh);


// --- Assets (Pipelines & Cables) ---
// Note: Realistically, a 1m diameter pipe seen from space is invisible.
// To make it viewable, we slightly exaggerate their width visually, or we rely on close-ups.
// Diameter is scaled up artificially by ~100x for visibility unless zoomed in,
// but since the prompt says "engineering realistic", we will use smaller radii but
// emissive or bright materials so they pop out. 
// 1.2 meters = 0.0012 km. If we use R=0.01 it's 10 meters thick.

function createPipeline(curve, radiusKm, colorHex, group, assetId) {
    // We need more radial segments to make vertex coloring smooth
    const geo = new THREE.TubeGeometry(curve, CURVE_RESOLUTION * 2, radiusKm, 12, false);

    // Setup Vertex Colors array (Default all White, so material color shows perfectly)
    const vertexCount = geo.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount * 3; i++) {
        colors[i] = 1.0;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.6,
        metalness: 0.4,
        vertexColors: true // Phase 3: Enable vertex colors for hazard heatmap
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Tag the mesh for raycasting and vertex updating
    mesh.userData = { assetId: assetId, baseColorHex: colorHex };
    group.add(mesh);
    assetMeshes[assetId] = mesh;

    // SILENTLY GENERATE 1KM DIGITAL SEGMENT NODES FOR THIS ASSET
    for (let kp = 0; kp < MAX_LENGTH; kp++) {
        const t = kp / MAX_LENGTH;
        const coord = interpolateCoord(t);
        const depth = getDepthKmAtKP(kp);
        const sector = determineSector(kp);

        const segment = new SegmentNode(
            `${assetId}_${kp}`,
            assetId,
            kp,
            kp + 1,
            coord.lat,
            coord.lon,
            depth,
            sector
        );
        digitalTwinDB.assets[assetId].push(segment);
        digitalTwinDB.sectors[sector].active_segments++;
    }
}

// Generate the 5 lines with respective offsets and slight burial (Y offset = -0.5m)
// 1. Gas Pipeline A (OffsetX: -600m)
const curveGasA = generateOffsetCurve(-600, -0.5);
createPipeline(curveGasA, 0.015, 0x00ff88, layers.gas, 'gas_a');

// 2. Gas Pipeline B (OffsetX: -200m)
const curveGasB = generateOffsetCurve(-200, -0.5);
createPipeline(curveGasB, 0.015, 0x00ff88, layers.gas, 'gas_b');

// 3. Crude Oil Pipeline (OffsetX: 200m)
const curveCrude = generateOffsetCurve(200, -0.5);
createPipeline(curveCrude, 0.018, 0xffcc00, layers.crude, 'crude');

// 4. HV Power Cable (OffsetX: 500m)
const curvePower = generateOffsetCurve(500, -0.5);
createPipeline(curvePower, 0.005, 0xff3b3b, layers.power, 'power');

// 5. Fiber Optic (OffsetX: 800m)
const curveFiber = generateOffsetCurve(800, -0.5);
createPipeline(curveFiber, 0.003, 0x00aaff, layers.fiber, 'fiber');


// --- Sector Boundaries ---
// 0, 350, 1100, 1550, 1900
const sectorKPs = [350, 1100, 1550];
sectorKPs.forEach(kp => {
    const t = kp / MAX_LENGTH;
    const pt = masterCurve.getPoint(t);
    const tangent = masterCurve.getTangent(t).normalize();
    const up = pt.clone().normalize(); // Away from earth center

    // Create a subtle glowing vertical wall or line cutting the corridor
    const wallGeo = new THREE.PlaneGeometry(10, 5); // 10km wide, 5km high
    const wallMat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const wall = new THREE.Mesh(wallGeo, wallMat);

    // Position and align
    wall.position.copy(pt);
    wall.position.add(up.clone().multiplyScalar(2.5)); // raise it up

    // Look at next point along path
    wall.lookAt(pt.clone().add(tangent));
    layers.sectors.add(wall);
});


// --- Resident Subsea Docking Stations ---
// 1 per sector: Sectors (0-350, 350-1100, 1100-1550, 1550-1900)
const stationKPs = [175, 725, 1325, 1725];

stationKPs.forEach((kp, idx) => {
    const t = kp / MAX_LENGTH;
    const pt = masterCurve.getPoint(t);
    const normal = frames.normals[Math.floor(t * CURVE_RESOLUTION)];
    const up = pt.clone().normalize();

    // Offset by 250m
    const stPos = pt.clone().add(normal.clone().multiplyScalar(0.25));

    // Simple boxy structure representing engineering docking station
    const stGroup = new THREE.Group();

    // Base
    const baseGeo = new THREE.BoxGeometry(0.1, 0.02, 0.15); // ~100m long base
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x445566, metalness: 0.8 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    stGroup.add(base);

    // Glowing port indicators
    const portGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
    const portL1 = new THREE.Mesh(portGeo, new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    portL1.position.set(-0.03, 0.02, 0.05);
    const portL2 = new THREE.Mesh(portGeo, new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    portL2.position.set(-0.03, 0.02, -0.05);
    const portT1 = new THREE.Mesh(portGeo, new THREE.MeshBasicMaterial({ color: 0x0088ff }));
    portT1.position.set(0.03, 0.02, 0);

    stGroup.add(portL1, portL2, portT1);

    // Align tightly to globe
    stGroup.position.copy(stPos);
    stGroup.lookAt(stPos.clone().add(up)); // face UP
    stGroup.rotateX(Math.PI / 2); // flatten to seabed

    layers.stations.add(stGroup);
});


// --------------------------------------------------------
// 4. HTML OVERLAYS (KP Markers & Station Labels)
// --------------------------------------------------------
const annotationsLayer = document.getElementById('annotations-layer');
const labels = [];
let kpLayerVisible = true;
let stationLayerVisible = true;

function createLabel(text, position, typeClass) {
    const el = document.createElement('div');
    el.className = typeClass;
    el.innerText = text;
    annotationsLayer.appendChild(el);
    labels.push({ element: el, position: position, type: typeClass });
}

// Generate KP Markers every 50 km
for (let kp = 0; kp <= MAX_LENGTH; kp += 50) {
    const t = kp / MAX_LENGTH;
    const pt = masterCurve.getPoint(t);
    // Push label slightly above seabed
    const up = pt.clone().normalize();
    pt.add(up.multiplyScalar(0.5));
    createLabel(`KP ${kp}`, pt, 'kp-marker');
}

// Generate Station Labels
stationKPs.forEach((kp, i) => {
    const t = kp / MAX_LENGTH;
    const pt = masterCurve.getPoint(t);
    const normal = frames.normals[Math.floor(t * CURVE_RESOLUTION)];
    const up = pt.clone().normalize();
    const stPos = pt.clone().add(normal.clone().multiplyScalar(0.25)).add(up.multiplyScalar(0.2));

    createLabel(`STATION ${String.fromCharCode(65 + i)}\nINV-AUV-1\nINV-AUV-2\nTOOL-AUV-1`, stPos, 'station-marker');
});

function updateLabels() {
    const tempV = new THREE.Vector3();
    labels.forEach(label => {
        // Toggle Check
        if (label.type === 'kp-marker' && !kpLayerVisible) {
            label.element.style.display = 'none'; return;
        }
        if (label.type === 'station-marker' && !stationLayerVisible) {
            label.element.style.display = 'none'; return;
        }

        tempV.copy(label.position);
        tempV.project(camera);

        // Check if behind camera
        if (tempV.z > 1) {
            label.element.style.display = 'none';
        } else {
            label.element.style.display = 'block';
            const x = (tempV.x * .5 + .5) * window.innerWidth;
            const y = (tempV.y * -.5 + .5) * window.innerHeight;
            label.element.style.left = `${x}px`;
            label.element.style.top = `${y}px`;
        }
    });
}


// --------------------------------------------------------
// 5. UI CONTROLS & EVENTS
// --------------------------------------------------------
// Layer checkboxes
document.getElementById('layer-gas').addEventListener('change', e => layers.gas.visible = e.target.checked);
document.getElementById('layer-crude').addEventListener('change', e => layers.crude.visible = e.target.checked);
document.getElementById('layer-power').addEventListener('change', e => layers.power.visible = e.target.checked);
document.getElementById('layer-fiber').addEventListener('change', e => layers.fiber.visible = e.target.checked);
document.getElementById('layer-sectors').addEventListener('change', e => layers.sectors.visible = e.target.checked);
document.getElementById('layer-bathymetry').addEventListener('change', e => layers.bathymetry.visible = e.target.checked);
document.getElementById('layer-stations').addEventListener('change', e => {
    layers.stations.visible = e.target.checked;
    stationLayerVisible = e.target.checked;
});
document.getElementById('layer-kp').addEventListener('change', e => {
    kpLayerVisible = e.target.checked;
});

// Debug Mode State
let debugModeActive = false;
const debugTooltip = document.getElementById('debug-tooltip');
document.getElementById('mode-debug').addEventListener('change', e => {
    debugModeActive = e.target.checked;
    if (!debugModeActive) debugTooltip.classList.add('hidden');
});

// --- Raycasting for Digital Twin Segments ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
// We only want to intersect the pipelines
const interactableObjects = [
    ...layers.gas.children,
    ...layers.crude.children,
    ...layers.power.children,
    ...layers.fiber.children
];

// Helper: Find closest Master Curve 't' from a 3D point
function findClosestTOnCurve(point, curve, resolution = 200) {
    let closestDistSq = Infinity;
    let closestT = 0;
    for (let i = 0; i <= resolution; i++) {
        const t = i / resolution;
        const pt = curve.getPoint(t);
        const distSq = point.distanceToSquared(pt);
        if (distSq < closestDistSq) {
            closestDistSq = distSq;
            closestT = t;
        }
    }
    return closestT;
}

window.addEventListener('mousemove', (event) => {
    if (!debugModeActive) return;

    // Update mouse coords for raycaster
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update tooltip position
    debugTooltip.style.left = `${event.clientX}px`;
    debugTooltip.style.top = `${event.clientY}px`;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(interactableObjects);

    if (intersects.length > 0) {
        // We hit a pipeline
        const hit = intersects[0];
        const assetId = hit.object.userData.assetId;

        // Find which KP we are roughly at by mapping to the master curve
        const closestT = findClosestTOnCurve(hit.point, masterCurve);

        // Convert 't' to KP, then index
        const exactKP = closestT * MAX_LENGTH;
        let segmentIndex = Math.floor(exactKP);

        // Safety bounds
        if (segmentIndex < 0) segmentIndex = 0;
        if (segmentIndex >= MAX_LENGTH) segmentIndex = MAX_LENGTH - 1;

        // Fetch Digital Twin Data
        const segmentData = digitalTwinDB.assets[assetId][segmentIndex];

        if (segmentData) {
            debugTooltip.classList.remove('hidden');

            // Populate UI
            document.getElementById('debug-asset-name').innerText = assetId.toUpperCase();
            document.getElementById('debug-kp').innerText = `${segmentData.kp_start} - ${segmentData.kp_end}`;
            document.getElementById('debug-coords').innerText = `${segmentData.latitude.toFixed(4)}, ${segmentData.longitude.toFixed(4)}`;
            document.getElementById('debug-depth').innerText = `${(segmentData.depth * 1000).toFixed(0)}m`;
            document.getElementById('debug-sector').innerText = `Sector ${segmentData.sector_id}`;
            document.getElementById('debug-health').innerText = segmentData.health_state.toUpperCase();
            document.getElementById('debug-uncertainty').innerText = segmentData.uncertainty_buffer.toFixed(2);
        }
    } else {
        // No hit
        debugTooltip.classList.add('hidden');
    }
});

// UI Hazard Injection Hook
document.getElementById('btn-inject').addEventListener('click', () => {
    const asset = document.getElementById('hz-asset').value;
    const kp = parseInt(document.getElementById('hz-kp').value) || 0;
    const type = document.getElementById('hz-type').value;
    const severity = document.getElementById('hz-severity').value;

    const hazard = new ActiveHazard(`HZ_${Date.now()}`, type, asset, kp, severity);
    digitalTwinDB.active_hazards.push(hazard);

    // Log
    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span class="warning-text">INJECTED: ${type.toUpperCase()}</span>
                       <span>Asset: ${asset.toUpperCase()} @ KP ${kp} | ${severity.toUpperCase()}</span>`;
    document.getElementById('event-log').prepend(logEl);
});

// AUV Dispatch Logic
const btnDispatch = document.getElementById('btn-dispatch-auv');
let currentCriticalTarget = null; // { assetId, kp }

btnDispatch.addEventListener('click', () => {
    if (!currentCriticalTarget) return;

    // Determine nearest station based on sector
    const sectorId = determineSector(currentCriticalTarget.kp);
    const stationKPs = { 'A': 175, 'B': 725, 'C': 1325, 'D': 1725 };
    const homeKp = stationKPs[sectorId];

    // Create AUV mathematically
    const auv = new AUVNode(`AUV-${sectorId}-INV`, homeKp);
    auv.target_kp = currentCriticalTarget.kp;
    auv.target_asset = currentCriticalTarget.assetId;
    auv.state = 'UNDOCKING';

    digitalTwinDB.active_auvs.push(auv);

    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span style="color: #00f0ff;">ACTION: MISSION DISPATCHED</span>
                       <span>${auv.id} from Station ${sectorId} to KP ${auv.target_kp}</span>`;
    document.getElementById('event-log').prepend(logEl);

    // Hide dispatch button now that it is sent
    btnDispatch.classList.add('hidden');
    document.getElementById('auv-telemetry').classList.remove('hidden');
});

// --- Phase 6: Human Approval Gate & Repair Dispatch ---
document.getElementById('btn-approve-multi').addEventListener('click', () => {
    document.getElementById('human-approval-modal').classList.add('hidden');
    if (window.pendingRepairRec && window.pendingRepairTarget) {
        triggerRepairMission(window.pendingRepairRec, window.pendingRepairTarget);
    }
});
document.getElementById('btn-escalate-shutdown').addEventListener('click', () => {
    document.getElementById('human-approval-modal').classList.add('hidden');
    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span class="critical-text">FULL SHUTDOWN ESCALATED</span>
                       <span>System halting all flow.</span>`;
    document.getElementById('event-log').prepend(logEl);
});
document.getElementById('btn-manual-override').addEventListener('click', () => {
    document.getElementById('human-approval-modal').classList.add('hidden');
    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span class="warning-text">MANUAL OVERRIDE</span>
                       <span>Monitoring only. No repair dispatched.</span>`;
    document.getElementById('event-log').prepend(logEl);
});

function triggerRepairMission(rec, target) {
    if (rec.isolation_required) {
        simulateIsolation(target);
    }
    dispatchRepairAUV(rec, target);
}

function simulateIsolation(target) {
    const seg = digitalTwinDB.assets[target.assetId][target.kp];
    seg.isolation_active = true;
    seg.isolation_timer = 0;
    seg.original_pressure = seg.sensor_cluster.pressure.current;

    digitalTwinDB.active_isolations = digitalTwinDB.active_isolations || [];
    if (!digitalTwinDB.active_isolations.includes(seg)) {
        digitalTwinDB.active_isolations.push(seg);
    }

    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span class="warning-text">ISOLATION INITIATED</span>
                       <span>Valves closing for ${target.assetId.toUpperCase()} around KP ${target.kp}</span>`;
    document.getElementById('event-log').prepend(logEl);
}

function simulatePressureReintroduction(seg) {
    seg.isolation_active = false;
    seg.reintro_active = true;
    seg.reintro_timer = 0;

    digitalTwinDB.active_isolations = digitalTwinDB.active_isolations || [];
    if (!digitalTwinDB.active_isolations.includes(seg)) {
        digitalTwinDB.active_isolations.push(seg);
    }

    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span class="nominal-text">PRESSURE REINTRODUCTION</span>
                       <span>Gradual flow restoration at KP ${seg.kp_start}.</span>`;
    document.getElementById('event-log').prepend(logEl);
}

function dispatchRepairAUV(rec, target) {
    let sectorId = 'A';
    if (target.kp <= 350) sectorId = 'A';
    else if (target.kp <= 1100) sectorId = 'B';
    else if (target.kp <= 1550) sectorId = 'C';
    else sectorId = 'D';

    const stationKPs = { 'A': 175, 'B': 725, 'C': 1325, 'D': 1725 };
    const homeKp = stationKPs[sectorId];

    // Primary Repair AUV
    const toolAuv = new AUVNode(`TOOL-AUV-${sectorId}-1`, homeKp);
    toolAuv.target_kp = target.kp;
    toolAuv.target_asset = target.assetId;
    toolAuv.state = 'UNDOCKING';
    toolAuv.mission_type = 'REPAIR';
    toolAuv.repair_rec = rec;

    digitalTwinDB.active_auvs.push(toolAuv);

    const logEl = document.createElement('div');
    logEl.className = 'log-entry';
    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                       <span style="color: #00f0ff;">REPAIR DISPATCH</span>
                       <span>${toolAuv.id} sent to ${target.assetId.toUpperCase()} @ KP ${target.kp}</span>`;
    document.getElementById('event-log').prepend(logEl);

    // Multi-AUV logic
    if (rec.repair_type === "Emergency Multi-AUV Repair" || rec.repair_type === "Isolation + Structural Repair") {
        const supportAuv = new AUVNode(`TOOL-AUV-${sectorId}-2`, homeKp);
        supportAuv.target_kp = target.kp;
        supportAuv.target_asset = target.assetId;
        supportAuv.state = 'UNDOCKING';
        supportAuv.mission_type = 'SUPPORT';
        digitalTwinDB.active_auvs.push(supportAuv);

        const logEl2 = document.createElement('div');
        logEl2.className = 'log-entry';
        logEl2.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                           <span style="color: #00f0ff;">SUPPORT DISPATCH</span>
                           <span>${supportAuv.id} deployed for Multi-AUV coordination.</span>`;
        document.getElementById('event-log').prepend(logEl2);
    }
}

// Time Dilation state
let SIM_TIME_DILATION = 1000;
document.getElementById('time-dilation').addEventListener('input', (e) => {
    SIM_TIME_DILATION = parseInt(e.target.value);
    document.getElementById('dilation-val').innerText = `${SIM_TIME_DILATION}x`;
});

// --------------------------------------------------------
// 2.7. DIGITAL TWIN SIMULATION TICK (2Hz)
// --------------------------------------------------------
const tmpColor = new THREE.Color();

function updateVertexColors(assetId) {
    const mesh = assetMeshes[assetId];
    if (!mesh) return;

    const geo = mesh.geometry;
    const colorAttr = geo.attributes.color;
    const segments = digitalTwinDB.assets[assetId];
    const baseColorHex = mesh.userData.baseColorHex;

    // We have 1900 segments (KPs). The tube has CURVE_RESOLUTION * 2 = 400 linear divisions.
    // So 1900 KPs map to 400 linear tube loops.
    // 1 linear loop = 1900/400 = 4.75 KPs
    // It has 12 radial segments.
    // Each linear step contains 12 vertices.

    const linearDivisions = CURVE_RESOLUTION * 2;
    const radialDivisions = 12;
    const kpPerDiv = MAX_LENGTH / linearDivisions;

    for (let i = 0; i <= linearDivisions; i++) {
        const kpApproximation = Math.floor(i * kpPerDiv);
        const segment = segments[Math.min(kpApproximation, MAX_LENGTH - 1)];
        const u = segment.uncertainty_buffer;

        // Heatmap scale:
        // u = 0.0 -> Base Color
        // u = 0.4 -> Amber (0xffaa00)
        // u = 0.7 -> Orange (0xff5500)
        // u = 1.0 -> Red (0xff0000)

        tmpColor.setHex(baseColorHex);
        if (u > 0.05) {
            let heatColor = 0xffaa00;
            if (u > 0.7) heatColor = 0xff0000;
            else if (u > 0.4) heatColor = 0xff5500;

            // Lerp based on intensity
            tmpColor.lerp(new THREE.Color(heatColor), Math.min(u, 1.0));
        }

        // Apply to all radial vertices at this linear step
        for (let j = 0; j <= radialDivisions; j++) {
            const idx = (i * (radialDivisions + 1) + j) * 3;
            // Handle array bounds
            if (idx + 2 < colorAttr.array.length) {
                colorAttr.array[idx] = tmpColor.r;
                colorAttr.array[idx + 1] = tmpColor.g;
                colorAttr.array[idx + 2] = tmpColor.b;
            }
        }
    }

    colorAttr.needsUpdate = true;
}

function simulateDigitalTwinTick() {
    // 0. Process Isolations & Pressure Reintroduction
    digitalTwinDB.active_isolations = digitalTwinDB.active_isolations || [];
    digitalTwinDB.active_isolations.forEach(seg => {
        if (seg.isolation_active) {
            seg.isolation_timer += 0.5 * SIM_TIME_DILATION;
            if (seg.sensor_cluster.pressure.current > seg.original_pressure * 0.1) {
                seg.sensor_cluster.pressure.current -= 5.0 * (0.5 * SIM_TIME_DILATION);
            }
        }
        if (seg.reintro_active) {
            seg.reintro_timer += 0.5 * SIM_TIME_DILATION;
            if (seg.sensor_cluster.pressure.current < seg.original_pressure) {
                seg.sensor_cluster.pressure.current += 2.0 * (0.5 * SIM_TIME_DILATION);
                if (Math.random() > 0.999) { // artificial spike
                    seg.reintro_active = false;
                    seg.isolation_active = true;
                    const logEl = document.createElement('div');
                    logEl.className = 'log-entry';
                    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                                      <span class="critical-text">RESTORE ABORTED</span>
                                      <span>Abnormal spike at KP ${Math.floor(seg.kp_start)}. Re-isolating.</span>`;
                    document.getElementById('event-log').prepend(logEl);
                }
            } else {
                seg.reintro_active = false;
                const logEl = document.createElement('div');
                logEl.className = 'log-entry';
                logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                                   <span class="nominal-text">PRESSURE STABILIZED</span>
                                   <span>Flow nominal at KP ${Math.floor(seg.kp_start)}.</span>`;
                document.getElementById('event-log').prepend(logEl);
                digitalTwinDB.active_isolations = digitalTwinDB.active_isolations.filter(s => s !== seg);
            }
        }
    });

    // 1. Process Hazards
    digitalTwinDB.active_hazards.forEach(hazard => {
        const segments = digitalTwinDB.assets[hazard.assetId];

        // Propagate across radius
        for (let i = -hazard.profile.radius; i <= hazard.profile.radius; i++) {
            const targetKp = hazard.kp + i;
            if (targetKp >= 0 && targetKp < MAX_LENGTH) {
                const seg = segments[targetKp];
                const sc = seg.sensor_cluster;

                // Exponential decay of impact based on distance
                const distanceFactor = Math.exp(-Math.abs(i) / (hazard.profile.radius / 2));

                // Apply physical drifts
                if (hazard.profile.strain) sc.strain.current += (hazard.profile.drift * hazard.profile.strain * distanceFactor);
                if (hazard.profile.pressure) sc.pressure.current += (hazard.profile.drift * hazard.profile.pressure * distanceFactor);
                if (hazard.profile.acoustic) sc.acoustic.current += (hazard.profile.drift * hazard.profile.acoustic * distanceFactor);
                if (hazard.profile.tilt) sc.tilt.current += (hazard.profile.drift * hazard.profile.tilt * distanceFactor);

                // Increase uncertainty buffer
                seg.uncertainty_buffer += (hazard.profile.uncertainty_accel * distanceFactor) * 0.1; // 0.1 delta per tick
                if (seg.uncertainty_buffer > 1.0) seg.uncertainty_buffer = 1.0;

                if (seg.uncertainty_buffer > 0.85 && seg.health_state === 'healthy') {
                    seg.health_state = 'critical risk';

                    // Log to UI strictly once per segment
                    const logEl = document.createElement('div');
                    logEl.className = 'log-entry';
                    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                                       <span class="critical-text">CRITICAL STRAIN DETECTED</span>
                                       <span>Asset: ${hazard.assetId.toUpperCase()} @ KP ${targetKp}. Review U-buffer.</span>`;
                    document.getElementById('event-log').prepend(logEl);

                    // Show AUV Dispatch Button if not already active
                    if (digitalTwinDB.active_auvs.length === 0) {
                        currentCriticalTarget = { assetId: hazard.assetId, kp: targetKp };
                        document.getElementById('btn-dispatch-auv').classList.remove('hidden');
                    }
                }
            }
        }
    });

    // 2. Update Sector Stability
    let requiresVisualUpdate = new Set();
    Object.keys(digitalTwinDB.sectors).forEach(secKey => {
        const sector = digitalTwinDB.sectors[secKey];
        let totalU = 0;
        let count = 0;

        ['gas_a', 'gas_b', 'crude', 'power', 'fiber'].forEach(assetId => {
            const segments = digitalTwinDB.assets[assetId];
            for (let kp = sector.kp_range[0]; kp < sector.kp_range[1]; kp++) {
                if (segments[kp].uncertainty_buffer > 0.01) {
                    totalU += segments[kp].uncertainty_buffer;
                    requiresVisualUpdate.add(assetId);
                }
                count++;
            }
        });

        if (count > 0) {
            sector.aggregated_variance = (totalU / count);
            sector.stability_index = 100.0 - (sector.aggregated_variance * 100);
            if (sector.stability_index < 0) sector.stability_index = 0;

            // Sync to UI panel if it exists
            const domEl = document.getElementById(`sector-sec-${secKey.toLowerCase()}`);
            if (domEl) {
                domEl.innerText = `${sector.stability_index.toFixed(1)}%`;
                if (sector.stability_index < 50) {
                    domEl.className = 'metric-value critical-text';
                } else if (sector.stability_index < 90) {
                    domEl.className = 'metric-value warning-text';
                } else {
                    domEl.className = 'metric-value nominal-text';
                }
            }
        }
    });

    // 3. Trigger Visual Mesh updates
    requiresVisualUpdate.forEach(assetId => updateVertexColors(assetId));
}

// Tick at 2Hz for performance
setInterval(simulateDigitalTwinTick, 500);

// --------------------------------------------------------
// 2.8. AUV PHYSICS LOOP (10Hz)
// --------------------------------------------------------
function simulateAUVPhysicsTick() {
    const dtReal = 0.1; // 10Hz = 0.1 seconds real-time
    const dtSim = dtReal * SIM_TIME_DILATION; // Simulated seconds passed this tick

    // We update UI elements directly from the array for simplicity
    digitalTwinDB.active_auvs.forEach(auv => {

        let powerDrawWatts = auv.base_power_watts;

        // --- State Machine ---
        if (auv.state === 'UNDOCKING') {
            auv.scan_timer += dtSim;
            if (auv.scan_timer > 60) { // Takes 60 physical seconds to undock
                auv.state = 'TRANSIT_VERTICAL';
                auv.scan_timer = 0;
            }
            powerDrawWatts += 1000; // Power-up heavy draw
        }
        else if (auv.state === 'TRANSIT_VERTICAL') {
            const targetDepth = getDepthKmAtKP(auv.current_kp);
            const diff = targetDepth - auv.depth;
            const dir = Math.sign(diff);

            // Vertical speed 1 m/s (0.001 km/s)
            auv.velocity_vertical = dir * 1.0;
            const distToMove = (auv.velocity_vertical * dtSim) / 1000; // km

            if (Math.abs(diff) < Math.abs(distToMove)) {
                auv.depth = targetDepth;
                auv.velocity_vertical = 0;
                auv.state = 'TRANSIT_HORIZONTAL';
            } else {
                auv.depth += distToMove;
            }
            powerDrawWatts += 2500; // Ballast pump energy
        }
        else if (auv.state === 'TRANSIT_HORIZONTAL') {
            auv.velocity_horizontal = 4.5; // Cruise at 4.5 knots
            const speedMs = auv.velocity_horizontal * 0.5144;

            // Move towards target KP (1 KP = 1 km roughly)
            const diff = auv.target_kp - auv.current_kp;
            const dir = Math.sign(diff);

            const distToMoveKm = (speedMs * dtSim) / 1000;

            if (Math.abs(diff) < Math.abs(distToMoveKm)) {
                auv.current_kp = auv.target_kp;
                auv.velocity_horizontal = 0;

                if (auv.current_kp === auv.home_kp) {
                    auv.state = 'IDLE';
                }
                else if (auv.mission_type === 'REPAIR' || auv.mission_type === 'SUPPORT') {
                    auv.state = 'ON_SITE_REPAIR';
                    auv.repair_phase = 1;
                    auv.scan_timer = 0;
                } else {
                    auv.state = 'ON_SITE_SCAN';
                    auv.scan_timer = 0;
                }
            } else {
                auv.current_kp += dir * distToMoveKm;
                // Follow the contour depth perfectly along the spline
                auv.depth = getDepthKmAtKP(auv.current_kp);
            }

            // Hydrodynamic drag power simplified approximation
            powerDrawWatts += (200 * speedMs * speedMs); // roughly 1kW at cruise
        }
        else if (auv.state === 'ON_SITE_SCAN') {
            auv.velocity_horizontal = 1.0; // Slow down to 1 knot
            auv.scan_timer += dtSim;
            powerDrawWatts += 4000; // Active sonar/scanners

            if (auv.scan_timer > 300) { // 5 minutes scan
                auv.state = 'REPORTING';
                auv.scan_timer = 0;
            }
        }
        else if (auv.state === 'REPORTING') {
            auv.scan_timer += dtSim;
            powerDrawWatts += 1500; // Comms array

            if (auv.scan_timer > 60) {
                // Tell the digital twin we confirmed it
                const seg = digitalTwinDB.assets[auv.target_asset][Math.floor(auv.current_kp)];
                if (seg && seg.health_state !== "confirmed anomaly") {
                    seg.health_state = "confirmed anomaly";

                    // Phase 6: DAMAGE SEVERITY EVALUATION
                    let integrity = 100 - (seg.uncertainty_buffer * 100);
                    if (seg.uncertainty_buffer > 0.85) {
                        integrity = 15 + Math.random() * 20; // < 40%
                    } else if (seg.uncertainty_buffer > 0.6) {
                        integrity = 41 + Math.random() * 15; // 40-60%
                    } else if (seg.uncertainty_buffer > 0.3) {
                        integrity = 61 + Math.random() * 20; // 60-85%
                    } else {
                        integrity = 86 + Math.random() * 10; // > 85%
                    }
                    seg.structural_integrity_percent = integrity;

                    const rec = {
                        anomaly_id: `ANOM-${Date.now()}`,
                        severity_class: '',
                        isolation_required: false,
                        repair_type: '',
                        estimated_repair_duration: 0,
                        required_tools: [],
                        human_approval_required: false
                    };

                    let actionLabel = "";
                    if (integrity > 85) {
                        rec.severity_class = "Minor";
                        rec.repair_type = "None";
                        actionLabel = "Monitor Only";
                    } else if (integrity >= 60) {
                        rec.severity_class = "Moderate";
                        rec.repair_type = "Preventive Clamp Repair";
                        rec.required_tools = ["Mechanical Clamp"];
                        rec.estimated_repair_duration = 1800; // 30 mins
                        actionLabel = "Preventive Clamp Repair";
                    } else if (integrity >= 40) {
                        rec.severity_class = "Severe";
                        rec.isolation_required = true;
                        rec.repair_type = "Isolation + Structural Repair";
                        rec.required_tools = ["Structural Clamp", "Welding Tools"];
                        rec.estimated_repair_duration = 3600; // 60 mins
                        actionLabel = "Isolation + Structural Repair";
                    } else {
                        rec.severity_class = "Critical";
                        rec.isolation_required = true;
                        rec.repair_type = "Emergency Multi-AUV Repair";
                        rec.required_tools = ["Heavy Structural Clamp", "Sealing Kit"];
                        rec.human_approval_required = true;
                        rec.estimated_repair_duration = 7200; // 120 mins
                        actionLabel = "Critical Event (Human Approval Required)";
                    }

                    const logEl = document.createElement('div');
                    logEl.className = 'log-entry';
                    logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                                       <span class="${rec.severity_class === 'Critical' ? 'critical-text' : 'warning-text'}">ASSESSMENT COMPLETE</span>
                                       <span>Integrity: ${integrity.toFixed(1)}% | Action: ${actionLabel}</span>`;
                    document.getElementById('event-log').prepend(logEl);

                    if (rec.human_approval_required) {
                        // Phase 7: Add to Human Oversight Panel
                        const oversightList = document.getElementById('oversight-list');
                        const emptyMsg = oversightList.querySelector('div');
                        if (emptyMsg && emptyMsg.innerText.includes('No pending')) {
                            oversightList.innerHTML = '';
                        }

                        const oversightId = `ov-${Date.now()}`;
                        const ovItem = document.createElement('div');
                        ovItem.id = oversightId;
                        ovItem.style.cssText = "background: rgba(187,170,255,0.1); border-left: 3px solid #bbaaff; padding: 0.5rem; border-radius: 4px; font-family: var(--font-log); font-size: 0.75rem; position: relative;";
                        ovItem.innerHTML = `
                            <div style="color:var(--text-primary); margin-bottom: 0.2rem;">REQ: ${rec.repair_type.toUpperCase()}</div>
                            <div style="color:var(--text-secondary); margin-bottom: 0.5rem;">${auv.target_asset.toUpperCase()} @ KP ${Math.floor(auv.current_kp)} | Integrity: <span class="critical-text">${integrity.toFixed(1)}%</span></div>
                            <div style="display: flex; gap: 0.5rem;">
                                <button class="btn" style="flex:1; padding: 0.2rem; font-size:0.65rem; border-color:#00ff88; color:#00ff88;" onclick="approveOversight('${oversightId}')">APPROVE</button>
                                <button class="btn" style="flex:1; padding: 0.2rem; font-size:0.65rem; border-color:#ff3b3b; color:#ff3b3b;" onclick="escalateOversight('${oversightId}')">ESCALATE</button>
                            </div>
                        `;
                        // Store data for the handlers
                        ovItem.dataset.rec = JSON.stringify(rec);
                        ovItem.dataset.asset = auv.target_asset;
                        ovItem.dataset.kp = Math.floor(auv.current_kp);

                        oversightList.appendChild(ovItem);

                        // Update counter
                        const countEl = document.getElementById('oversight-count');
                        countEl.innerText = parseInt(countEl.innerText || 0) + 1;

                        const modal = document.getElementById('human-approval-modal');
                        document.getElementById('approval-details').innerHTML = `
                            <strong>Asset:</strong> ${auv.target_asset.toUpperCase()} @ KP ${Math.floor(auv.current_kp)}<br>
                            <strong>Structural Integrity:</strong> <span class="critical-text">${integrity.toFixed(1)}%</span><br>
                            <strong>Repair Type:</strong> ${rec.repair_type}<br>
                            <strong>Required Tools:</strong> ${rec.required_tools.join(", ")}
                        `;
                        modal.classList.remove('hidden');

                        window.pendingRepairRec = rec;
                        window.pendingRepairTarget = { assetId: auv.target_asset, kp: Math.floor(auv.current_kp) };
                    } else if (rec.repair_type !== "None") {
                        triggerRepairMission(rec, { assetId: auv.target_asset, kp: Math.floor(auv.current_kp) });
                    }
                }

                // Done reporting, return home
                auv.target_kp = auv.home_kp;
                auv.state = 'TRANSIT_HORIZONTAL';
                auv.scan_timer = 0;
            }
        }
        else if (auv.state === 'ON_SITE_REPAIR') {
            auv.velocity_horizontal = 0; // Station keeping
            auv.scan_timer += dtSim;

            const seg = digitalTwinDB.assets[auv.target_asset][Math.floor(auv.current_kp)];

            if (auv.mission_type === 'SUPPORT') {
                powerDrawWatts += 2000; // stabilization assist
                const primaryAuv = digitalTwinDB.active_auvs.find(a => a.mission_type === 'REPAIR' && a.target_kp === auv.target_kp && a.target_asset === auv.target_asset && a.state === 'ON_SITE_REPAIR');
                if (!primaryAuv) {
                    auv.target_kp = auv.home_kp;
                    auv.state = 'TRANSIT_HORIZONTAL';
                    auv.mission_type = null;
                }
            } else if (auv.mission_type === 'REPAIR') {
                powerDrawWatts += 4500; // Tool usage

                // Phase 1: Structural assessment
                if (auv.repair_phase === 1 && auv.scan_timer > 30) {
                    auv.repair_phase = 2; auv.scan_timer = 0;
                    if (seg) seg.health_state = "repair - stabilize";
                }
                // Phase 2: Position stabilization
                else if (auv.repair_phase === 2 && auv.scan_timer > 30) {
                    auv.repair_phase = 3; auv.scan_timer = 0;
                    if (seg) seg.health_state = "repair - clamp align";
                }
                // Phase 3: Clamp alignment
                else if (auv.repair_phase === 3 && auv.scan_timer > 40) {
                    auv.repair_phase = 4; auv.scan_timer = 0;
                    if (seg) { seg.structural_integrity_percent = Math.max(seg.structural_integrity_percent, 50); seg.health_state = "repair - clamp deploy"; }
                }
                // Phase 4: Mechanical clamp deployment
                else if (auv.repair_phase === 4 && auv.scan_timer > 60) {
                    auv.repair_phase = 5; auv.scan_timer = 0;
                    if (seg) { seg.structural_integrity_percent = 85; seg.health_state = "repair - seal test"; }
                }
                // Phase 5: Seal pressure test
                else if (auv.repair_phase === 5 && auv.scan_timer > 40) {
                    auv.repair_phase = 6; auv.scan_timer = 0;
                    if (seg) { seg.structural_integrity_percent = 92; seg.health_state = "repair - check"; }
                }
                // Phase 6: Structural reinforcement check
                else if (auv.repair_phase === 6 && auv.scan_timer > 30) {
                    auv.state = 'REPORTING_REPAIR';
                    auv.scan_timer = 0;
                    if (seg) seg.structural_integrity_percent = 96;
                }
            }
        }
        else if (auv.state === 'REPORTING_REPAIR') {
            auv.scan_timer += dtSim;
            powerDrawWatts += 1500;
            if (auv.scan_timer > 60) {
                auv.target_kp = auv.home_kp;
                auv.state = 'TRANSIT_HORIZONTAL';
                auv.scan_timer = 0;

                const seg = digitalTwinDB.assets[auv.target_asset][Math.floor(auv.current_kp)];
                if (seg) {
                    if (seg.structural_integrity_percent > 90) {
                        seg.health_state = "Repaired & Stabilized";
                        seg.uncertainty_buffer = 0.05; // Reset uncertainty
                        seg.last_repair_timestamp = Date.now();
                        seg.anomaly_resolved = true;

                        const logEl = document.createElement('div');
                        logEl.className = 'log-entry';
                        logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                                           <span class="nominal-text">REPAIR SUCCESS</span>
                                           <span>Sector ${determineSector(seg.kp_start)} - ${auv.target_asset.toUpperCase()} @ KP ${Math.floor(auv.current_kp)}</span>`;
                        document.getElementById('event-log').prepend(logEl);

                        if (auv.repair_rec && auv.repair_rec.isolation_required) {
                            simulatePressureReintroduction(seg);
                        }

                        // Clear related hazards
                        digitalTwinDB.active_hazards = digitalTwinDB.active_hazards.filter(h => !(h.assetId === auv.target_asset && Math.abs(h.kp - auv.current_kp) <= h.profile.radius));
                    } else {
                        seg.health_state = "Repair Incomplete — Human Intervention Recommended";
                    }
                }
                auv.mission_type = null;
                auv.repair_rec = null;
            }
        }
        else if (auv.state === 'IDLE') {
            if (auv.battery_joules < auv.battery_max_joules) {
                auv.battery_joules += 15000 * dtSim; // 15kW docking array charging
                if (auv.battery_joules > auv.battery_max_joules) auv.battery_joules = auv.battery_max_joules;
            }
        }

        // --- Energy Math ---
        // Joules = Watts * Seconds
        const energyConsumedJ = powerDrawWatts * dtSim;
        auv.battery_joules -= energyConsumedJ;

        // --- Update UI ---
        // --- Update UI ---
        document.getElementById('auv-id').innerText = auv.id;
        document.getElementById('auv-state').innerText = auv.state + (auv.repair_phase ? ` (Phase ${auv.repair_phase})` : '');
        document.getElementById('auv-battery').innerText = auv.battery_percent.toFixed(2) + '%';

        const targetD = auv.target_kp ? getDepthKmAtKP(auv.target_kp) * 1000 : 0;
        document.getElementById('auv-depth').innerText = `${Math.floor(auv.depth * 1000)}m`;
        document.getElementById('auv-speed').innerText = auv.velocity_horizontal.toFixed(1);

        if (auv.target_kp !== null && auv.state.includes('TRANSIT')) {
            const dist = Math.abs(auv.target_kp - auv.current_kp); // in KM
            document.getElementById('auv-dist').innerText = `${dist.toFixed(1)} km`;

            const speed = (auv.velocity_horizontal * 0.5144) || 0.1;
            const etaRealSeconds = (dist * 1000) / speed;
            const etaSimSeconds = etaRealSeconds / SIM_TIME_DILATION;
            document.getElementById('auv-eta').innerText = `~${Math.ceil(etaSimSeconds)}s`;
        } else {
            document.getElementById('auv-dist').innerText = `--`;
            document.getElementById('auv-eta').innerText = `--`;
        }
    });
}

setInterval(simulateAUVPhysicsTick, 100);

// --------------------------------------------------------
// 6. CAMERA NAVIGATION LOGIC
// --------------------------------------------------------
const GLOBAL_POS = masterCurve.getPoint(0.5).clone().normalize().multiplyScalar(R_EARTH + 1200);
const GLOBAL_LOOK = masterCurve.getPoint(0.5);

camera.position.copy(GLOBAL_POS);
camera.lookAt(GLOBAL_LOOK);

let cameraTarget = GLOBAL_LOOK.clone();

function switchMode(mode) {
    document.querySelectorAll('.nav-controls .btn').forEach(b => b.classList.remove('active-nav'));

    if (mode === 'GLOBAL') {
        document.getElementById('nav-global').classList.add('active-nav');
        document.getElementById('val-sector').innerText = 'GLOBAL';

        gsap.to(camera.position, {
            x: GLOBAL_POS.x, y: GLOBAL_POS.y, z: GLOBAL_POS.z,
            duration: 3, ease: 'power2.inOut'
        });
        gsap.to(cameraTarget, {
            x: GLOBAL_LOOK.x, y: GLOBAL_LOOK.y, z: GLOBAL_LOOK.z,
            duration: 3, ease: 'power2.inOut'
        });
    }
    else if (mode === 'SECTOR') {
        document.getElementById('nav-sector').classList.add('active-nav');
        document.getElementById('val-sector').innerText = 'SECTOR B [DEEP BASIN]';

        const pt = masterCurve.getPoint(0.4); // Focus on deep basin
        const up = pt.clone().normalize();
        const navPos = pt.clone().add(up.multiplyScalar(40)); // 40km above

        gsap.to(camera.position, {
            x: navPos.x, y: navPos.y, z: navPos.z,
            duration: 4, ease: 'power3.inOut'
        });
        gsap.to(cameraTarget, {
            x: pt.x, y: pt.y, z: pt.z,
            duration: 4, ease: 'power3.inOut'
        });
    }
    else if (mode === 'INSPECTION') {
        document.getElementById('nav-inspection').classList.add('active-nav');
        document.getElementById('val-sector').innerText = 'STATION B [CLOSE UP]';

        const focusKp = 725; // Station B
        const t = focusKp / MAX_LENGTH;
        const pt = masterCurve.getPoint(t);
        const tangent = masterCurve.getTangent(t);
        const up = pt.clone().normalize();

        // Go 2km up, slightly shifted back along tangent
        const navPos = pt.clone().add(up.multiplyScalar(1.5)).sub(tangent.multiplyScalar(3));

        gsap.to(camera.position, {
            x: navPos.x, y: navPos.y, z: navPos.z,
            duration: 4, ease: 'power3.inOut'
        });
        gsap.to(cameraTarget, {
            x: pt.x, y: pt.y, z: pt.z,
            duration: 4, ease: 'power3.inOut'
        });
    }
}

document.getElementById('nav-global').onclick = () => switchMode('GLOBAL');
document.getElementById('nav-sector').onclick = () => switchMode('SECTOR');
document.getElementById('nav-inspection').onclick = () => switchMode('INSPECTION');

// --------------------------------------------------------
// 7. RENDER LOOP
// --------------------------------------------------------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
    requestAnimationFrame(animate);
    camera.lookAt(cameraTarget);

    updateLabels(); // Sync 2D HTML markers with 3D projection

    renderer.render(scene, camera);
}
animate();

// --------------------------------------------------------
// 8. PHASE 7: MASTER DASHBOARD METRICS LOGIC
// --------------------------------------------------------
let sysConfidence = 99.9;

function updateDashboardMetrics() {
    // Top Bar
    const now = new Date();
    document.getElementById('top-time').innerText = now.toISOString().split('T')[1].slice(0, 8);
    document.getElementById('top-auv-active').innerText = digitalTwinDB.active_auvs.length;
    document.getElementById('top-isolations').innerText = digitalTwinDB.active_isolations ? digitalTwinDB.active_isolations.length : 0;

    // Global Stats
    let totalAnomalies = 0;
    let totalStability = 0;
    let assessedSegments = 0;
    let totalUncertainty = 0;
    let hazardCount = digitalTwinDB.active_hazards.length;

    Object.keys(digitalTwinDB.assets).forEach(asset => {
        digitalTwinDB.assets[asset].forEach(seg => {
            totalStability += seg.structural_integrity_percent || 100;
            totalUncertainty += seg.uncertainty_buffer;
            if (seg.health_state !== 'healthy' && !seg.anomaly_resolved) totalAnomalies++;
            assessedSegments++;
        });
    });

    const avgStability = (totalStability / assessedSegments).toFixed(1);
    const avgUncertainty = (totalUncertainty / assessedSegments).toFixed(3);
    document.getElementById('val-global-stability').innerText = `${avgStability}%`;
    document.getElementById('val-active-anomalies').innerText = totalAnomalies;
    document.getElementById('val-active-missions').innerText = digitalTwinDB.active_auvs.length;
    document.getElementById('val-avg-uncertainty').innerText = avgUncertainty;

    let confidenceTarget = 100 - (totalAnomalies * 0.5) - (hazardCount * 2);
    if (confidenceTarget < 20) confidenceTarget = 20;
    sysConfidence = sysConfidence * 0.9 + confidenceTarget * 0.1;
    document.getElementById('val-confidence').innerText = `${sysConfidence.toFixed(1)}%`;

    // System Health
    document.getElementById('val-sim-hazards').innerText = hazardCount;

    // Comms & Latency
    const latency = Math.floor(12 + Math.random() * 5 + (hazardCount * 15));
    document.getElementById('val-latency').innerText = latency;
    const commsInt = latency > 100 ? 85 : 100;
    document.getElementById('val-comms-int').innerText = `${commsInt}%`;

    // Status changes
    const sysStatus = document.getElementById('sys-status');
    if (totalAnomalies > 5 || (digitalTwinDB.active_isolations && digitalTwinDB.active_isolations.length > 0)) {
        sysStatus.innerHTML = `SYS: CRITICAL <span class="indicator" style="background-color: var(--color-critical); box-shadow: 0 0 8px var(--color-critical-glow);"></span>`;
        sysStatus.style.color = "var(--color-critical)";
    } else if (totalAnomalies > 0 || hazardCount > 0) {
        sysStatus.innerHTML = `SYS: ALERT <span class="indicator" style="background-color: var(--color-warning); box-shadow: 0 0 8px var(--color-warning-glow);"></span>`;
        sysStatus.style.color = "var(--color-warning)";
    } else {
        sysStatus.innerHTML = `SYS: NOMINAL <span class="indicator"></span>`;
        sysStatus.style.color = "var(--text-primary)";
    }

    // Sector Control logic
    updateSectorControl();

    // Bio-Algae Update
    updateBioAlgae();
}

let currentSelectedSector = null;

function updateSectorControl() {
    if (!currentSelectedSector) return;
    const sectorStats = {
        'A': { range: 'KP 0 - 350', depth: '20m - 60m', stationId: 'A' },
        'B': { range: 'KP 350 - 1100', depth: '60m - 4200m', stationId: 'B' },
        'C': { range: 'KP 1100 - 1550', depth: '4200m - 800m', stationId: 'C' },
        'D': { range: 'KP 1550 - 1900', depth: '800m - 50m', stationId: 'D' }
    };

    document.getElementById('sec-kp-range').innerText = sectorStats[currentSelectedSector].range;
    document.getElementById('sec-depth-range').innerText = sectorStats[currentSelectedSector].depth;
    document.getElementById('sec-station-id').innerText = sectorStats[currentSelectedSector].stationId;

    // Filter active AUVs in sector
    const auvList = document.getElementById('sec-auv-list');
    auvList.innerHTML = '';

    const baseAuvs = [
        { id: `AUV-${currentSelectedSector}-INV-1`, role: 'Investigation', status: 'Docked / Charging', batt: 100 },
        { id: `AUV-${currentSelectedSector}-INV-2`, role: 'Investigation', status: 'Docked / Standby', batt: 100 },
        { id: `TOOL-AUV-${currentSelectedSector}-1`, role: 'Heavy Tool', status: 'Docked / Ready', batt: 100 }
    ];

    baseAuvs.forEach(base => {
        const active = digitalTwinDB.active_auvs.find(a => a.id === base.id);
        const batt = active ? active.battery_percent.toFixed(1) : base.batt;
        const status = active ? `In Mission (${active.state})` : base.status;
        const color = active ? 'var(--color-warning)' : 'var(--color-nominal)';

        auvList.innerHTML += `
            <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 0.3rem;">
                <span style="color:${color}">${base.id}</span>
                <span class="nominal-text">${batt}%</span>
                <span>${status}</span>
            </div>`;
    });
}

// Bio-Algae Simulation
let bioAlgaeData = {
    'A': { yield: 85, power: 12.4, trend: 1 },
    'B': { yield: 65, power: 8.2, trend: 1 },
    'C': { yield: 92, power: 14.1, trend: -1 },
    'D': { yield: 78, power: 10.5, trend: 1 }
};
function updateBioAlgae() {
    if (!currentSelectedSector) return;
    const data = bioAlgaeData[currentSelectedSector];

    // Fluctuate slightly
    if (Math.random() > 0.8) {
        data.yield += data.trend * Math.random() * 0.5;
        data.power = data.yield * 0.15;
        if (data.yield > 98) data.trend = -1;
        if (data.yield < 40) data.trend = 1;
    }

    document.getElementById('bio-yield').innerText = `${data.yield.toFixed(1)}%`;
    document.getElementById('bio-power').innerText = `+${data.power.toFixed(1)}%`;

    const statusEl = document.getElementById('bio-status');
    if (data.yield < 50) {
        statusEl.innerText = 'LOW YIELD';
        statusEl.style.color = 'var(--color-warning)';
        statusEl.style.borderColor = 'var(--color-warning)';
    } else {
        statusEl.innerText = 'ACTIVE';
        statusEl.style.color = '#00ff88';
        statusEl.style.borderColor = '#00ff88';
    }
}

setInterval(updateDashboardMetrics, 500);

// Hook sector nav clicks
document.getElementById('nav-sector').addEventListener('click', () => {
    currentSelectedSector = 'B';
    document.getElementById('sector-control-panel').classList.remove('hidden');
});
document.getElementById('nav-global').addEventListener('click', () => {
    currentSelectedSector = null;
    document.getElementById('sector-control-panel').classList.add('hidden');
});
document.getElementById('nav-inspection').addEventListener('click', () => {
    currentSelectedSector = 'B';
    document.getElementById('sector-control-panel').classList.remove('hidden');
});

document.getElementById('btn-close-sector').addEventListener('click', () => {
    document.getElementById('sector-control-panel').classList.add('hidden');
});

// Hook abort button
document.getElementById('btn-abort-mission').addEventListener('click', () => {
    const auvId = document.getElementById('auv-id').innerText;
    const auv = digitalTwinDB.active_auvs.find(a => a.id === auvId);
    if (auv) {
        auv.mission_type = 'ABORT';
        auv.target_kp = auv.home_kp;
        auv.state = 'TRANSIT_HORIZONTAL';

        const logEl = document.createElement('div');
        logEl.className = 'log-entry';
        logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                           <span class="critical-text">MISSION ABORTED</span>
                           <span>${auv.id} returning to base.</span>`;
        document.getElementById('event-log').prepend(logEl);

        document.getElementById('auv-telemetry').classList.add('hidden');
    }
});

// Global oversight handlers
window.approveOversight = function (id) {
    const el = document.getElementById(id);
    if (el) {
        const rec = JSON.parse(el.dataset.rec);
        const target = { assetId: el.dataset.asset, kp: parseInt(el.dataset.kp) };
        triggerRepairMission(rec, target);
        removeOversight(id);
        document.getElementById('human-approval-modal').classList.add('hidden'); // Also close modal if open
    }
};

window.escalateOversight = function (id) {
    const el = document.getElementById(id);
    if (el) {
        const logEl = document.createElement('div');
        logEl.className = 'log-entry';
        logEl.innerHTML = `<span class="log-timestamp">${new Date().toISOString().split('T')[1].slice(0, 8)}</span>
                           <span class="critical-text">FULL SHUTDOWN ESCALATED</span>
                           <span>System halting all flow.</span>`;
        document.getElementById('event-log').prepend(logEl);
        removeOversight(id);
        document.getElementById('human-approval-modal').classList.add('hidden');
    }
};

function removeOversight(id) {
    const el = document.getElementById(id);
    if (el) {
        el.remove();
        const countEl = document.getElementById('oversight-count');
        let count = parseInt(countEl.innerText || 0) - 1;
        countEl.innerText = count < 0 ? 0 : count;

        const oversightList = document.getElementById('oversight-list');
        if (oversightList.children.length === 0) {
            oversightList.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No pending approvals</div>`;
        }
    }
}
