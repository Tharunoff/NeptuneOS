// NeptuneOS Simulation Logic

// --- State Machine ---
const STATES = {
    NORMAL: 'NORMAL',
    UNCERTAINTY: 'UNCERTAINTY',
    DISPATCH: 'DISPATCH',
    UPDATE: 'UPDATE'
};
let currentState = STATES.NORMAL;

// --- DOM Elements ---
const els = {
    btnInvestigate: document.getElementById('btn-investigate'),
    valState: document.getElementById('val-state'),
    valIntegrity: document.getElementById('val-integrity'),
    barIntegrity: document.getElementById('bar-integrity'),
    valConfidence: document.getElementById('val-confidence'),
    barConfidence: document.getElementById('bar-confidence'),
    valKp: document.getElementById('val-kp'),
    eventLog: document.getElementById('event-log'),
    alerts: document.getElementById('alerts-container'),
    panels: document.querySelectorAll('.panel'),
    topBar: document.querySelector('.top-bar'),
    sysStatus: document.getElementById('sys-status')
};

// --- Logger ---
function addLog(msg, type = 'info') {
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    // Add color marker based on type
    let colorHex = 'var(--color-nominal)';
    if (type === 'warning') colorHex = 'var(--color-warning)';
    if (type === 'critical') colorHex = 'var(--color-critical)';
    entry.style.borderLeftColor = colorHex;

    const time = new Date().toISOString().split('T')[1].slice(0, 11) + 'Z';
    entry.innerHTML = `
        <div class="log-timestamp">[${time}] sys.${type.toUpperCase()}</div>
        <div class="log-message" style="color: ${colorHex}">${msg}</div>
    `;
    els.eventLog.appendChild(entry);
    els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

// --- FSM Transitions ---
function transition(newState) {
    if (currentState === newState) return;
    currentState = newState;
    els.valState.innerText = currentState;

    // Reset UI state classes
    els.panels.forEach(p => { p.classList.remove('state-warning', 'state-critical'); });
    els.topBar.classList.remove('state-warning', 'state-critical');

    // Reset styling
    els.valState.className = 'value';

    switch (newState) {
        case STATES.NORMAL:
            // UI
            els.valState.classList.add('nominal-text');
            els.valIntegrity.innerText = '100%';
            els.valIntegrity.className = 'metric-value nominal-text';
            els.barIntegrity.style.width = '100%';
            els.barIntegrity.className = 'progress-fill nominal-bg';

            els.valConfidence.innerText = 'LOW';
            els.valConfidence.className = 'metric-value nominal-text';
            els.barConfidence.style.width = '20%';
            els.barConfidence.className = 'progress-fill nominal-bg';

            els.valKp.innerText = '--';
            els.valKp.className = 'metric-value nominal-text';

            // Buttons
            els.btnInvestigate.disabled = false;
            els.btnInvestigate.onclick = () => transition(STATES.UNCERTAINTY);
            els.btnInvestigate.innerHTML = '<span class="btn-icon">🔍</span> INVESTIGATE';

            // 3D
            gsap.to(materials.pipeline.color, { r: 0.0, g: 1.0, b: 0.5, duration: 1 });
            gsap.to(materials.risk.uniforms.opacity, { value: 0.0, duration: 1 });
            gsap.to(auv.position, { x: 30, z: -10, duration: 5, ease: 'power2.inOut' });
            break;

        case STATES.UNCERTAINTY:
            // UI
            els.valState.classList.add('warning-text');
            els.panels.forEach(p => p.classList.add('state-warning'));
            els.topBar.classList.add('state-warning');

            els.valIntegrity.innerText = '82%';
            els.valIntegrity.className = 'metric-value warning-text';
            els.barIntegrity.style.width = '82%';
            els.barIntegrity.className = 'progress-fill warning-bg';

            els.valConfidence.innerText = 'MEDIUM';
            els.valConfidence.className = 'metric-value warning-text';
            els.barConfidence.style.width = '55%';
            els.barConfidence.className = 'progress-fill warning-bg';

            els.valKp.innerText = 'CALCULATING...';
            els.valKp.className = 'metric-value warning-text animated-ellipsis';

            // Buttons
            els.btnInvestigate.disabled = false;
            els.btnInvestigate.className = 'btn critical-btn';
            els.btnInvestigate.onclick = () => transition(STATES.DISPATCH);
            els.btnInvestigate.innerHTML = '<span class="btn-icon">🎯</span> RUN DETECTION';

            // 3D
            gsap.to(materials.pipeline.color, { r: 1.0, g: 0.8, b: 0.0, duration: 2 });
            gsap.to(materials.risk.uniforms.opacity, { value: 0.5, duration: 2 });

            addLog('Acoustic anomaly detected on sector alpha.', 'warning');
            addLog('Uncertainty build-up. Risk zone established.', 'warning');
            break;

        case STATES.DISPATCH:
            // UI
            els.valState.classList.add('critical-text');
            els.panels.forEach(p => p.classList.add('state-critical'));
            els.topBar.classList.add('state-critical');

            els.valConfidence.innerText = 'HIGH';
            els.valConfidence.className = 'metric-value critical-text';
            els.barConfidence.style.width = '95%';
            els.barConfidence.className = 'progress-fill critical-bg';

            els.valKp.innerText = 'KP 32-36';
            els.valKp.className = 'metric-value critical-text';

            // Buttons
            els.btnInvestigate.disabled = false;
            els.btnInvestigate.className = 'btn nominal-btn';
            els.btnInvestigate.onclick = () => transition(STATES.UPDATE);
            els.btnInvestigate.innerHTML = '<span class="btn-icon">🔄</span> INGEST OBSERVATION';

            // 3D
            addLog('Certainty collapse achieved: Fault isolated.', 'critical');
            addLog('Dispatching autonomous underwater vehicle (AUV)...', 'critical');

            // AUV moves from base to risk zone
            gsap.to(auv.position, {
                x: config.anomalyPos.x + 2,
                z: config.anomalyPos.z + 2,
                duration: 4,
                ease: 'power2.inOut',
                onComplete: () => {
                    addLog('AUV on site. Commencing close-range structural scan.', 'info');
                }
            });

            // Camera zooms in slightly
            gsap.to(camera.position, {
                x: 15, y: 10, z: 15, duration: 4, ease: 'power2.inOut'
            });
            break;

        case STATES.UPDATE:
            // UI
            els.valState.classList.add('nominal-text'); // Return to nominal
            els.valIntegrity.innerText = '94%'; // Slightly degraded but known
            els.barIntegrity.style.width = '94%';

            els.valConfidence.innerText = 'RESOLVED';
            els.valConfidence.className = 'metric-value nominal-text';

            els.valKp.innerText = 'KP 34.46';
            els.valKp.className = 'metric-value nominal-text';

            // Buttons
            els.btnInvestigate.disabled = true;

            // 3D
            addLog('High-res scan complete. Observation ingested.', 'info');
            addLog('Model Updated. Risk zone parameters collapsed.', 'nominal');

            gsap.to(materials.pipeline.color, { r: 0.0, g: 1.0, b: 0.5, duration: 1.5 });
            gsap.to(riskZone.scale, { x: 0.1, y: 0.1, z: 0.1, duration: 1.5, ease: 'back.in(1.7)' });
            gsap.to(materials.risk.uniforms.opacity, {
                value: 0.0, duration: 1.5, onComplete: () => {
                    // Reset scale for next time
                    riskZone.scale.set(1, 1, 1);
                }
            });

            // AUV returns
            gsap.to(auv.position, {
                x: 30, z: -10, duration: 5, ease: 'power1.inOut', delay: 1.5
            });

            // Camera returns
            gsap.to(camera.position, {
                x: defaultCameraPos.x, y: defaultCameraPos.y, z: defaultCameraPos.z,
                duration: 5, ease: 'power2.inOut', delay: 1.5
            });

            // Go back to NORMAL after a few seconds
            setTimeout(() => {
                transition(STATES.NORMAL);
                addLog('System stabilizing. Resuming autonomous monitoring.', 'info');
            }, 8000);

            break;
    }
}

// Button Listeners handled dynamically in FSM now

// --- Three.js Setup ---
const config = {
    anomalyPos: { x: -5, y: 0, z: 0 },
};

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05080e, 0.015);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
// Fixed Isometric/Elevated camera
const defaultCameraPos = new THREE.Vector3(25, 20, 25);
camera.position.copy(defaultCameraPos);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.getElementById('canvas-container').appendChild(renderer.domElement);

// Lights
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0x00f0ff, 0.8);
dirLight.position.set(20, 40, 20);
scene.add(dirLight);

const dirLight2 = new THREE.DirectionalLight(0xff3b3b, 0.3);
dirLight2.position.set(-20, 20, -20);
scene.add(dirLight2);

// Simple pseudo-random noise function for terrain
function snoise(x, z) {
    return Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2.0 + Math.sin(x * 0.05 + z * 0.05) * 1.5;
}

// Materials Storage
const materials = {};

// 1. Terrain Engine (Realistic Sandbox)
const terrainGeo = new THREE.PlaneGeometry(120, 120, 64, 64);
// Apply smooth noise
const posArr = terrainGeo.attributes.position.array;
for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i];
    const y = posArr[i + 1]; // PlaneGeometry creates on XY plane, then we rotate
    posArr[i + 2] = snoise(x, y); // Z becomes Y after rotation
}
terrainGeo.computeVertexNormals();

const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x2a3628, // Muted sandy/silt green-brown
    roughness: 0.9,
    metalness: 0.1,
    flatShading: false
});
const terrain = new THREE.Mesh(terrainGeo, terrainMat);
terrain.rotation.x = -Math.PI / 2;
terrain.position.y = -2;
scene.add(terrain);

// Solid base
const baseGeo = new THREE.PlaneGeometry(120, 120);
const baseMat = new THREE.MeshStandardMaterial({ color: 0x111b15 });
const baseMesh = new THREE.Mesh(baseGeo, baseMat);
baseMesh.rotation.x = -Math.PI / 2;
baseMesh.position.y = -6; // push deeper
scene.add(baseMesh);

// 2. Water Environment
scene.fog = new THREE.FogExp2(0x0a1e29, 0.02); // Deep blue-green fog, denser

const waterGeo = new THREE.PlaneGeometry(150, 150);
const waterMat = new THREE.MeshStandardMaterial({
    color: 0x001522,
    transparent: true,
    opacity: 0.85, // More opaque, less glassy
    roughness: 0.1,
    metalness: 0.1,
    depthWrite: false
});
const water = new THREE.Mesh(waterGeo, waterMat);
water.rotation.x = -Math.PI / 2;
water.position.y = 12; // Higher water level
scene.add(water);

// 3. Pipeline (Cylinder along X axis)
materials.pipeline = new THREE.MeshStandardMaterial({
    color: 0x00ff88, // Nominal green
    roughness: 0.7, // Matte
    metalness: 0.3  // Not too glossy
});
const pipeGeo = new THREE.CylinderGeometry(0.8, 0.8, 100, 32);
const pipeline = new THREE.Mesh(pipeGeo, materials.pipeline);
pipeline.rotation.z = Math.PI / 2;
pipeline.position.y = -1;
scene.add(pipeline);

// Add pipe joints and supports
for (let i = -40; i <= 40; i += 10) {
    // Joint
    const jointGeo = new THREE.CylinderGeometry(0.95, 0.95, 1, 16);
    const jointMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.8, metalness: 0.4 });
    const joint = new THREE.Mesh(jointGeo, jointMat);
    joint.rotation.z = Math.PI / 2;
    joint.position.set(i, -1, 0);
    scene.add(joint);

    // Concrete Support
    const supportGeo = new THREE.BoxGeometry(2.5, 1.5, 2.5);
    const supportMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9, metalness: 0.1 });
    const support = new THREE.Mesh(supportGeo, supportMat);
    support.position.set(i, -2.25, 0); // Resting on seabed
    scene.add(support);
}

// 4. AUV (Industrial Inspection Torpedo)
auv = new THREE.Group();

// Main Torpedo Body
const bodyGeo = new THREE.CylinderGeometry(0.6, 0.6, 3.5, 32);
const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xdddddf, // Neutral light grey/white
    metalness: 0.2,
    roughness: 0.7
});
const body = new THREE.Mesh(bodyGeo, bodyMat);
body.rotation.z = Math.PI / 2;

// Nose Cone (Sensor Array)
const noseGeo = new THREE.SphereGeometry(0.6, 32, 16, 0, Math.PI);
const noseMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
const nose = new THREE.Mesh(noseGeo, noseMat);
nose.rotation.z = -Math.PI / 2;
nose.position.x = 1.75;

// Spotlight for sensor array
const sensorLight = new THREE.SpotLight(0xffffff, 2);
sensorLight.angle = Math.PI / 6;
sensorLight.penumbra = 0.5;
sensorLight.distance = 20;
sensorLight.position.set(1.75, 0, 0);
sensorLight.target.position.set(20, -5, 0); // Point forward and slightly down
auv.add(sensorLight);
auv.add(sensorLight.target);

// Tail Cone
const tailGeo = new THREE.ConeGeometry(0.6, 1.2, 32);
const tail = new THREE.Mesh(tailGeo, bodyMat);
tail.rotation.z = -Math.PI / 2;
tail.position.x = -2.35;

// Thruster Prop guard
const guardGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.5, 16);
const guardMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5, roughness: 0.5 });
const guard = new THREE.Mesh(guardGeo, guardMat);
guard.rotation.z = Math.PI / 2;
guard.position.x = -3.0;

// Stabilizer Fins
const finMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6 });
const finTopGeo = new THREE.BoxGeometry(0.8, 0.6, 0.1);
const finTop = new THREE.Mesh(finTopGeo, finMat);
finTop.position.set(-2, 0.8, 0);

const finBot = finTop.clone();
finBot.position.set(-2, -0.8, 0);

const finSideGeo = new THREE.BoxGeometry(0.8, 0.1, 1.6);
const finSide = new THREE.Mesh(finSideGeo, finMat);
finSide.position.set(-2, 0, 0);

auv.add(body);
auv.add(nose);
auv.add(tail);
auv.add(guard);
auv.add(finTop);
auv.add(finBot);
auv.add(finSide);

auv.position.set(30, 2, -10); // Start at base
auv.rotation.y = Math.PI / 4;
auv.scale.set(0.8, 0.8, 0.8); // Scale to fit Scene
scene.add(auv);

// 5. Risk Zone Volume (Translucent Red Sphere with Custom Shader for Hologram feel)
const riskGeo = new THREE.SphereGeometry(6, 32, 32);

// Simple volumetric soft-edge shader
const vShader = `
    varying vec3 vPosition;
    void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const fShader = `
    uniform float opacity;
    varying vec3 vPosition;
    void main() {
        float dist = length(vPosition) / 6.0; // 6 is the radius
        float intensity = smoothstep(1.0, 0.0, dist);
        gl_FragColor = vec4(1.0, 0.2, 0.2, intensity);
        gl_FragColor.a *= opacity * 0.8;
    }
`;
materials.risk = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0.0 } },
    vertexShader: vShader,
    fragmentShader: fShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide
});

riskZone = new THREE.Mesh(riskGeo, materials.risk);
riskZone.position.set(config.anomalyPos.x, config.anomalyPos.y, config.anomalyPos.z);
scene.add(riskZone);

// Highlight Pipeline segment under risk zone
const highlightGeo = new THREE.CylinderGeometry(0.85, 0.85, 15, 16);
const highlightMat = new THREE.MeshBasicMaterial({
    color: 0xffaa00,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending
});
const pipeHighlight = new THREE.Mesh(highlightGeo, highlightMat);
pipeHighlight.rotation.z = Math.PI / 2;
pipeHighlight.position.set(config.anomalyPos.x, -1, 0);
scene.add(pipeHighlight);

// Make the highlight opacity linked to the risk material opacity
gsap.ticker.add(() => {
    highlightMat.opacity = materials.risk.uniforms.opacity.value * 0.8;
});


// Initialization Logs & Loop inside a trigger function
let isSimInitialized = false;
const clock = new THREE.Clock();

function initSimulation() {
    if (isSimInitialized) return;
    isSimInitialized = true;

    // Size it correctly now that the container is visible
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);

    addLog('System booting...', 'info');
    addLog('NeptuneOS active. Connected to subsea sensor array.', 'nominal');

    // Jump straight to Uncertainty as demanded by the map anomaly workflow
    transition(STATES.UNCERTAINTY);

    animate();
}

function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();

    // AUV hovering animation
    if (auv) {
        auv.position.y = 2 + Math.sin(time * 2) * 0.2;

        const targetX = currentState === STATES.DISPATCH ? config.anomalyPos.x : 30;
        const targetZ = currentState === STATES.DISPATCH ? config.anomalyPos.z : -10;
        const dx = targetX - auv.position.x;
        const dz = targetZ - auv.position.z;
        if (Math.abs(dx) > 0.1 || Math.abs(dz) > 0.1) {
            const angle = Math.atan2(dx, dz);
            auv.rotation.y += (angle - auv.rotation.y) * 0.05;
        }
    }

    // Risk zone pulsing
    if (currentState === STATES.UNCERTAINTY || currentState === STATES.DISPATCH) {
        const pulse = 1 + Math.sin(time * 3) * 0.05;
        riskZone.scale.set(pulse, pulse, pulse);
    }

    waterMat.opacity = 0.3 + Math.sin(time) * 0.02;
    renderer.render(scene, camera);
}

// Map View Interaction Logic
const mapEls = {
    view: document.getElementById('map-view'),
    popup: document.getElementById('map-popup'),
    anomalies: document.querySelectorAll('.anomaly-point-svg'),
    btnSendAuv: document.getElementById('btn-send-auv'),
    btnClosePopup: document.getElementById('btn-close-popup'),
    simView: document.getElementById('simulation-view')
};

let selectedAnomaly = null;

mapEls.anomalies.forEach(point => {
    point.addEventListener('click', (e) => {
        selectedAnomaly = e.target.closest('.anomaly-point-svg').id;
        mapEls.popup.classList.remove('hidden');
    });
});

mapEls.btnClosePopup.addEventListener('click', () => {
    mapEls.popup.classList.add('hidden');
    selectedAnomaly = null;
});

mapEls.btnSendAuv.addEventListener('click', () => {
    mapEls.btnSendAuv.innerHTML = `<span class="btn-icon">⏳</span> SENDING AUV...`;

    setTimeout(() => {
        mapEls.view.classList.add('hidden');
        mapEls.simView.style.display = 'block';

        initSimulation();

        setTimeout(() => {
            transition(STATES.DISPATCH);
        }, 800);

    }, 1500);
});

// Resize handler
window.addEventListener('resize', () => {
    if (!isSimInitialized) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
