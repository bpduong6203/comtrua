/**
 * ComTrua — Three.js 3D Background Scene Manager
 * ================================================
 * Floating particle system with mouse parallax, theme-aware colors,
 * FPS-based performance auto-scaling, and mobile optimization.
 */

const ComTrua3D = (() => {
	// ── State ──
	let scene, camera, renderer, clock;
	let particles = [];
	let glowOrbs = [];
	let mouseX = 0, mouseY = 0;
	let targetMouseX = 0, targetMouseY = 0;
	let animFrameId = null;
	let isEnabled = true;
	let isInitialized = false;
	let currentTheme = 'warm-light';
	let fpsHistory = [];
	let lastFpsCheck = 0;
	let qualityLevel = 1; // 1 = full, 0.5 = reduced, 0 = minimal

	// ── Configuration per theme ──
	const THEME_CONFIG = {
		'warm-light': {
			particleColors: [0xE8613C, 0xF4A261, 0xFFD4A8, 0xFF8C61, 0xFFC078],
			orbColors: [0xE8613C, 0xF4A261],
			bgTint: 0xFFFCFA,
			particleShapes: ['sphere', 'ring', 'diamond'],
			ambientIntensity: 0.6,
		},
		'liquid-glass': {
			particleColors: [0x007AFF, 0x5AC8FA, 0x64D2FF, 0x30D5C8, 0xB4F0FF],
			orbColors: [0x007AFF, 0x5AC8FA],
			bgTint: 0xF0F6FF,
			particleShapes: ['sphere', 'ring', 'cube'],
			ambientIntensity: 0.5,
		},
		'midnight-aurora': {
			particleColors: [0x00E5A0, 0x00B4D8, 0x48CAE4, 0x90E0EF, 0x00F5D4],
			orbColors: [0x00E5A0, 0x00B4D8],
			bgTint: 0x0A0F1C,
			particleShapes: ['sphere', 'diamond', 'ring'],
			ambientIntensity: 0.3,
		},
		'sweet-pink': {
			particleColors: [0xFF85A1, 0xFF4D6D, 0xFFB3C6, 0xFF758F, 0xFFC2D4],
			orbColors: [0xFF85A1, 0xFF4D6D],
			bgTint: 0xFFF5F7,
			particleShapes: ['sphere', 'ring', 'heart'],
			ambientIntensity: 0.6,
		}
	};

	// ── Particle count based on device ──
	function getParticleCount() {
		const isMobile = window.innerWidth < 768;
		const isLowEnd = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
		const base = isMobile ? 25 : 50;
		if (isLowEnd) return Math.floor(base * 0.6);
		return Math.floor(base * qualityLevel);
	}

	function getOrbCount() {
		const isMobile = window.innerWidth < 768;
		return isMobile ? 3 : 6;
	}

	// ── Three.js Setup ──
	function init() {
		if (isInitialized) return;

		// Check user preference
		const savedPref = localStorage.getItem('comtrua-3d-effects');
		if (savedPref === 'off') {
			isEnabled = false;
			return;
		}

		// Check prefers-reduced-motion
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			isEnabled = false;
			return;
		}

		// Detect current theme
		const themeAttr = document.documentElement.getAttribute('data-theme');
		currentTheme = themeAttr || 'warm-light';

		try {
			// Scene
			scene = new THREE.Scene();

			// Camera
			camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
			camera.position.z = 30;

			// Renderer
			renderer = new THREE.WebGLRenderer({
				alpha: true,
				antialias: qualityLevel > 0.5,
				powerPreference: 'low-power'
			});
			renderer.setSize(window.innerWidth, window.innerHeight);
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
			renderer.setClearColor(0x000000, 0);

			// Canvas styling
			const canvas = renderer.domElement;
			canvas.id = 'three-bg-canvas';
			canvas.style.cssText = `
				position: fixed;
				top: 0;
				left: 0;
				width: 100%;
				height: 100%;
				z-index: -1;
				pointer-events: none;
				opacity: 0;
				transition: opacity 1.2s ease;
			`;
			document.body.prepend(canvas);

			// Fade in
			requestAnimationFrame(() => {
				canvas.style.opacity = '1';
			});

			// Clock
			clock = new THREE.Clock();

			// Create particles
			createParticles();
			createGlowOrbs();

			// Events
			window.addEventListener('mousemove', onMouseMove, { passive: true });
			window.addEventListener('resize', onResize, { passive: true });
			window.addEventListener('touchmove', onTouchMove, { passive: true });

			// Observe theme changes
			const observer = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.attributeName === 'data-theme') {
						const newTheme = document.documentElement.getAttribute('data-theme') || 'warm-light';
						if (newTheme !== currentTheme) {
							currentTheme = newTheme;
							updateThemeColors();
						}
					}
				}
			});
			observer.observe(document.documentElement, { attributes: true });

			isInitialized = true;

			// Start animation loop
			animate();

		} catch (err) {
			console.warn('ComTrua3D: WebGL not available or error:', err);
			isEnabled = false;
		}
	}

	// ── Create floating particles ──
	function createParticles() {
		const config = THEME_CONFIG[currentTheme] || THEME_CONFIG['warm-light'];
		const count = getParticleCount();

		for (let i = 0; i < count; i++) {
			const color = config.particleColors[Math.floor(Math.random() * config.particleColors.length)];
			const shape = config.particleShapes[Math.floor(Math.random() * config.particleShapes.length)];
			// Make particles larger so they are clearly visible
			const size = 0.2 + Math.random() * 0.5;

			let geometry;
			switch (shape) {
				case 'ring':
					geometry = new THREE.TorusGeometry(size, size * 0.25, 8, 16);
					break;
				case 'diamond':
					geometry = new THREE.OctahedronGeometry(size, 0);
					break;
				case 'cube':
					geometry = new THREE.BoxGeometry(size, size, size);
					break;
				case 'heart':
					// Approximated with sphere
					geometry = new THREE.SphereGeometry(size, 8, 8);
					break;
				default: // sphere
					geometry = new THREE.SphereGeometry(size, 12, 12);
			}

			// Adjust opacity for theme visibility (needs to be higher on light themes)
			const minOpacity = currentTheme === 'midnight-aurora' ? 0.25 : 0.35;
			const maxOpacity = currentTheme === 'midnight-aurora' ? 0.45 : 0.45;
			const material = new THREE.MeshBasicMaterial({
				color: color,
				transparent: true,
				opacity: minOpacity + Math.random() * maxOpacity,
				wireframe: Math.random() > 0.6,
			});

			const mesh = new THREE.Mesh(geometry, material);

			// Random position in 3D space
			mesh.position.set(
				(Math.random() - 0.5) * 60,
				(Math.random() - 0.5) * 40,
				(Math.random() - 0.5) * 20 - 5
			);

			// Random rotation
			mesh.rotation.set(
				Math.random() * Math.PI * 2,
				Math.random() * Math.PI * 2,
				Math.random() * Math.PI * 2
			);

			// Store animation data
			mesh.userData = {
				baseX: mesh.position.x,
				baseY: mesh.position.y,
				baseZ: mesh.position.z,
				speedX: (Math.random() - 0.5) * 0.3,
				speedY: 0.05 + Math.random() * 0.2,
				speedZ: (Math.random() - 0.5) * 0.1,
				rotSpeedX: (Math.random() - 0.5) * 0.01,
				rotSpeedY: (Math.random() - 0.5) * 0.01,
				rotSpeedZ: (Math.random() - 0.5) * 0.005,
				floatOffset: Math.random() * Math.PI * 2,
				floatAmplitude: 0.5 + Math.random() * 2,
				driftAmplitude: 0.3 + Math.random() * 1.5,
			};

			scene.add(mesh);
			particles.push(mesh);
		}
	}

	// ── Create soft glow orbs (larger, blurred light sources) ──
	function createGlowOrbs() {
		const config = THEME_CONFIG[currentTheme] || THEME_CONFIG['warm-light'];
		const count = getOrbCount();

		for (let i = 0; i < count; i++) {
			const color = config.orbColors[i % config.orbColors.length];
			// Increase orb size for more visible background ambient glow
			const size = 5.0 + Math.random() * 8.0;

			const geometry = new THREE.SphereGeometry(size, 16, 16);
			// Adjust opacity for theme visibility (needs to be higher on light themes)
			const minOpacity = currentTheme === 'midnight-aurora' ? 0.08 : 0.12;
			const maxOpacity = currentTheme === 'midnight-aurora' ? 0.1 : 0.15;
			const material = new THREE.MeshBasicMaterial({
				color: color,
				transparent: true,
				opacity: minOpacity + Math.random() * maxOpacity,
			});

			const orb = new THREE.Mesh(geometry, material);
			orb.position.set(
				(Math.random() - 0.5) * 50,
				(Math.random() - 0.5) * 30,
				-10 - Math.random() * 10
			);

			orb.userData = {
				baseX: orb.position.x,
				baseY: orb.position.y,
				driftSpeed: 0.1 + Math.random() * 0.2,
				driftOffset: Math.random() * Math.PI * 2,
				driftRange: 3 + Math.random() * 5,
				pulseSpeed: 0.3 + Math.random() * 0.5,
				pulseOffset: Math.random() * Math.PI * 2,
				baseOpacity: material.opacity,
			};

			scene.add(orb);
			glowOrbs.push(orb);
		}
	}

	// ── Update colors when theme changes ──
	function updateThemeColors() {
		const config = THEME_CONFIG[currentTheme] || THEME_CONFIG['warm-light'];

		// Update particle colors and opacity
		particles.forEach((p, i) => {
			const newColor = config.particleColors[i % config.particleColors.length];
			p.material.color.setHex(newColor);

			// Adjust opacity for theme visibility
			const minOpacity = currentTheme === 'midnight-aurora' ? 0.25 : 0.35;
			const maxOpacity = currentTheme === 'midnight-aurora' ? 0.45 : 0.45;
			p.material.opacity = minOpacity + Math.random() * maxOpacity;
		});

		// Update orb colors and base opacity
		glowOrbs.forEach((orb, i) => {
			const newColor = config.orbColors[i % config.orbColors.length];
			orb.material.color.setHex(newColor);

			// Adjust base opacity for theme visibility
			const minOpacity = currentTheme === 'midnight-aurora' ? 0.08 : 0.12;
			const maxOpacity = currentTheme === 'midnight-aurora' ? 0.1 : 0.15;
			orb.userData.baseOpacity = minOpacity + Math.random() * maxOpacity;
		});
	}

	// ── Mouse tracking ──
	function onMouseMove(e) {
		targetMouseX = (e.clientX / window.innerWidth - 0.5) * 2;
		targetMouseY = (e.clientY / window.innerHeight - 0.5) * 2;
	}

	function onTouchMove(e) {
		if (e.touches.length > 0) {
			targetMouseX = (e.touches[0].clientX / window.innerWidth - 0.5) * 2;
			targetMouseY = (e.touches[0].clientY / window.innerHeight - 0.5) * 2;
		}
	}

	// ── Resize handler ──
	function onResize() {
		if (!renderer || !camera) return;
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight);
	}

	// ── FPS-based quality auto-scaling ──
	function checkPerformance(delta) {
		const now = performance.now();
		if (now - lastFpsCheck < 2000) return; // Check every 2 seconds
		lastFpsCheck = now;

		const fps = 1 / delta;
		fpsHistory.push(fps);
		if (fpsHistory.length > 5) fpsHistory.shift();

		const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;

		if (avgFps < 20 && qualityLevel > 0) {
			qualityLevel = Math.max(0, qualityLevel - 0.25);
			rebuildParticles();
		} else if (avgFps > 50 && qualityLevel < 1) {
			qualityLevel = Math.min(1, qualityLevel + 0.1);
		}
	}

	// ── Rebuild particles after quality change ──
	function rebuildParticles() {
		// Remove existing
		particles.forEach(p => {
			p.geometry.dispose();
			p.material.dispose();
			scene.remove(p);
		});
		glowOrbs.forEach(o => {
			o.geometry.dispose();
			o.material.dispose();
			scene.remove(o);
		});
		particles = [];
		glowOrbs = [];

		// Recreate with new count
		createParticles();
		createGlowOrbs();
	}

	// ── Animation loop ──
	function animate() {
		if (!isEnabled) return;
		animFrameId = requestAnimationFrame(animate);

		const delta = clock.getDelta();
		const elapsed = clock.getElapsedTime();

		// Performance check
		checkPerformance(delta);

		// Smooth mouse interpolation
		mouseX += (targetMouseX - mouseX) * 0.03;
		mouseY += (targetMouseY - mouseY) * 0.03;

		// Camera subtle movement based on mouse
		camera.position.x += (mouseX * 2 - camera.position.x) * 0.02;
		camera.position.y += (-mouseY * 1.5 - camera.position.y) * 0.02;
		camera.lookAt(0, 0, 0);

		// Animate particles
		for (const p of particles) {
			const d = p.userData;

			// Floating Y motion
			p.position.y = d.baseY + Math.sin(elapsed * d.speedY + d.floatOffset) * d.floatAmplitude;

			// Gentle X drift
			p.position.x = d.baseX + Math.sin(elapsed * d.speedX * 0.5 + d.floatOffset) * d.driftAmplitude;

			// Subtle Z breathing
			p.position.z = d.baseZ + Math.sin(elapsed * d.speedZ + d.floatOffset) * 0.5;

			// Rotation
			p.rotation.x += d.rotSpeedX;
			p.rotation.y += d.rotSpeedY;
			p.rotation.z += d.rotSpeedZ;

			// Mouse parallax on particles
			p.position.x += mouseX * 0.3 * (1 + p.position.z * 0.05);
			p.position.y += -mouseY * 0.2 * (1 + p.position.z * 0.05);
		}

		// Animate glow orbs
		for (const orb of glowOrbs) {
			const d = orb.userData;

			// Slow drift
			orb.position.x = d.baseX + Math.sin(elapsed * d.driftSpeed + d.driftOffset) * d.driftRange;
			orb.position.y = d.baseY + Math.cos(elapsed * d.driftSpeed * 0.7 + d.driftOffset) * d.driftRange * 0.6;

			// Pulse opacity
			orb.material.opacity = d.baseOpacity + Math.sin(elapsed * d.pulseSpeed + d.pulseOffset) * 0.02;

			// Scale pulse
			const scalePulse = 1 + Math.sin(elapsed * d.pulseSpeed * 0.5 + d.pulseOffset) * 0.08;
			orb.scale.setScalar(scalePulse);

			// Mouse parallax (less than particles for depth)
			orb.position.x += mouseX * 0.5;
			orb.position.y += -mouseY * 0.3;
		}

		renderer.render(scene, camera);
	}

	// ── Public API ──
	return {
		init(retryCount = 0) {
			// Wait for Three.js to be available
			if (typeof THREE === 'undefined') {
				if (retryCount < 5) {
					console.log(`ComTrua3D: THREE.js not loaded yet. Retrying in 200ms... (attempt ${retryCount + 1}/5)`);
					setTimeout(() => ComTrua3D.init(retryCount + 1), 200);
				} else {
					console.warn('ComTrua3D: THREE.js failed to load after retries.');
				}
				return;
			}
			init();
		},

		toggle() {
			isEnabled = !isEnabled;
			localStorage.setItem('comtrua-3d-effects', isEnabled ? 'on' : 'off');

			const canvas = document.getElementById('three-bg-canvas');
			if (canvas) {
				canvas.style.opacity = isEnabled ? '1' : '0';
				canvas.style.pointerEvents = 'none';
			}

			if (isEnabled && isInitialized) {
				clock = new THREE.Clock();
				animate();
			} else if (!isEnabled && animFrameId) {
				cancelAnimationFrame(animFrameId);
				animFrameId = null;
			}

			return isEnabled;
		},

		isEnabled() {
			return isEnabled;
		},

		setTheme(themeName) {
			if (themeName !== currentTheme) {
				currentTheme = themeName;
				if (isInitialized && isEnabled) {
					updateThemeColors();
				}
			}
		},

		destroy() {
			if (animFrameId) cancelAnimationFrame(animFrameId);
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('touchmove', onTouchMove);

			particles.forEach(p => {
				p.geometry.dispose();
				p.material.dispose();
				scene.remove(p);
			});
			glowOrbs.forEach(o => {
				o.geometry.dispose();
				o.material.dispose();
				scene.remove(o);
			});

			if (renderer) {
				renderer.dispose();
				const canvas = document.getElementById('three-bg-canvas');
				if (canvas) canvas.remove();
			}

			particles = [];
			glowOrbs = [];
			isInitialized = false;
		}
	};
})();
	};
})();
