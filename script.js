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

// Global state container
const digitalTwinDB = {
    assets: {
        'gas_a': [],
        'gas_b': [],
        'crude': [],
        'power': [],
        'fiber': []
    },
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
    const geo = new THREE.TubeGeometry(curve, CURVE_RESOLUTION * 2, radiusKm, 8, false);
    const mat = new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.6,
        metalness: 0.4
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Tag the mesh for raycasting
    mesh.userData = { assetId: assetId };
    group.add(mesh);

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
