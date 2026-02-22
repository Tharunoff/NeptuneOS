import re

with open("index.html", "r", encoding="utf-8") as f:
    html = f.read()

# Replace tooltip structure
html = html.replace(
    '''<div id="universal-tooltip" class="universal-tooltip hidden">
            <div class="tooltip-title" id="tt-title"></div>
            <div class="tooltip-desc" id="tt-desc"></div>
        </div>''',
    '''<div id="universal-tooltip" class="universal-tooltip hidden">
            <div class="tooltip-title" id="tt-title"></div>
            <div class="tooltip-line" id="tt-line1"></div>
            <div class="tooltip-line" id="tt-line2"></div>
            <div class="tooltip-line" id="tt-line3"></div>
        </div>'''
)

# Replace Sector Stability
html = html.replace(
    '''data-tooltip="Sector Stability"
                                    data-tooltip-desc="Aggregated probabilistic risk score across KP segments."''',
    '''data-tooltip="Sector Stability"
                                    data-tooltip-short="Aggregated probabilistic risk score." data-tooltip-tech="Derived from Bayesian risk modeling across KP segments."'''
)
html = html.replace(
    'data-tooltip="Sector Stability" data-tooltip-desc="Aggregated probabilistic risk score across KP segments."',
    'data-tooltip="Sector Stability" data-tooltip-short="Aggregated probabilistic risk score." data-tooltip-tech="Derived from Bayesian risk modeling across KP segments."'
)

# Replace Hazard Engine
html = html.replace(
    '''data-tooltip="Hazard Engine"
                            data-tooltip-desc="Inject and simulate physical failure events."''',
    '''data-tooltip="Hazard Engine"
                            data-tooltip-short="Inject simulated failure scenarios." data-tooltip-tech="Used to test system detection and response capability."'''
)
html = html.replace(
    'data-tooltip="Hazard Engine" data-tooltip-desc="Inject and simulate physical failure events."',
    'data-tooltip="Hazard Engine" data-tooltip-short="Inject simulated failure scenarios." data-tooltip-tech="Used to test system detection and response capability."'
)

# Bio-Energy Harvest
html = html.replace(
    '<span>BIO-ALGAE HARVEST</span>',
    '<span class="neptune-tooltip" data-tooltip="Bio-Energy Harvest" data-tooltip-short="Marine algae-based supplemental energy system." data-tooltip-tech="Reduces reliance on external power sources.">BIO-ALGAE HARVEST</span>'
)

# AUV Fleet
html = html.replace(
    '<div class="accordion-item" data-panel="fleet-panel">',
    '<div class="accordion-item neptune-tooltip" data-panel="fleet-panel" data-tooltip="AUV Fleet" data-tooltip-short="Monitor AUV battery, readiness, and mission status." data-tooltip-tech="Used to assess deployment capability.">'
)

# Isolation
html = html.replace(
    '''<button id="btn-approve-multi" class="btn critical-btn">Approve Isolation + Multi-AUV
                        Deployment</button>''',
    '''<button id="btn-approve-multi" class="btn critical-btn neptune-tooltip" data-tooltip="Isolation Control" data-tooltip-short="Temporarily close upstream and downstream valves." data-tooltip-tech="Prevents escalation of structural damage." data-tooltip-use="Execute immediately upon critical threshold breach.">Approve Isolation + Multi-AUV 
                        Deployment</button>'''
)
html = html.replace(
    '<button id="btn-approve-multi" class="btn critical-btn">Approve Isolation + Multi-AUV Deployment</button>',
    '<button id="btn-approve-multi" class="btn critical-btn neptune-tooltip" data-tooltip="Isolation Control" data-tooltip-short="Temporarily close upstream and downstream valves." data-tooltip-tech="Prevents escalation of structural damage." data-tooltip-use="Execute immediately upon critical threshold breach.">Approve Isolation + Multi-AUV Deployment</button>'
)

# Navigation Modes
html = html.replace(
    'data-tooltip="Global Curvature Mode" data-tooltip-desc="View the entire 1900km corridor."',
    'data-tooltip="Global Curvature Mode" data-tooltip-short="Switch camera and system visualization modes." data-tooltip-tech="Changes operational view without affecting system logic." data-tooltip-use="View the entire 1900km corridor."'
)
html = html.replace(
    '''data-tooltip="Sector Mode"
                        data-tooltip-desc="Zoom to specific operating sectors."''',
    '''data-tooltip="Sector Mode"
                        data-tooltip-short="Switch camera and system visualization modes." data-tooltip-tech="Changes operational view without affecting system logic." data-tooltip-use="Zoom to specific operating sectors."'''
)
html = html.replace(
    'data-tooltip="Sector Mode" data-tooltip-desc="Zoom to specific operating sectors."',
    'data-tooltip="Sector Mode" data-tooltip-short="Switch camera and system visualization modes." data-tooltip-tech="Changes operational view without affecting system logic." data-tooltip-use="Zoom to specific operating sectors."'
)
html = html.replace(
    '''data-tooltip="Inspection Mode"
                        data-tooltip-desc="Close-up seabed visualization."''',
    '''data-tooltip="Inspection Mode"
                        data-tooltip-short="Switch camera and system visualization modes." data-tooltip-tech="Changes operational view without affecting system logic." data-tooltip-use="Close-up seabed visualization."'''
)
html = html.replace(
    'data-tooltip="Inspection Mode" data-tooltip-desc="Close-up seabed visualization."',
    'data-tooltip="Inspection Mode" data-tooltip-short="Switch camera and system visualization modes." data-tooltip-tech="Changes operational view without affecting system logic." data-tooltip-use="Close-up seabed visualization."'
)

# Replace all remaining data-tooltip-desc with data-tooltip-short basically for others
html = html.replace('data-tooltip-desc', 'data-tooltip-short')

with open("index.html", "w", encoding="utf-8") as f:
    f.write(html)
