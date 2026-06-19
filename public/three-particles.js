/**
 * ComTrua — Three.js Micro-interaction Particles
 * =================================================
 * Celebration effects: confetti burst, coin rain, ripple explosions.
 * Lightweight overlay that renders on demand, then auto-disposes.
 */

const ComTruaFX = (() => {
	let fxScene, fxCamera, fxRenderer;
	let fxAnimFrameId = null;
	let fxClock;
	let activeSystems = [];
	let isReady = false;

	// ── Colors per theme ──
	const CONFETTI_COLORS = {
		'warm-light': [0xE8613C, 0xF4A261, 0xFFD4A8, 0xFF8C61, 0x2D9B4E, 0x007AFF],
		'liquid-glass': [0x007AFF, 0x5AC8FA, 0x64D2FF, 0x30D5C8, 0xFF6B9D, 0xFFD700],
		'midnight-aurora': [0x00E5A0, 0x00B4D8, 0x48CAE4, 0xFF6B9D, 0xFFD700, 0x90E0EF],
		'sweet-pink': [0xFF85A1, 0xFF4D6D, 0xFFB3C6, 0xFFD700, 0x64D2FF, 0x2D9B4E],
	};

	const COIN_COLORS = {
		'warm-light': [0xFFD700, 0xFFA500, 0xDAA520],
		'liquid-glass': [0xFFD700, 0x5AC8FA, 0xDAA520],
		'midnight-aurora': [0xFFD700, 0x00E5A0, 0xDAA520],
		'sweet-pink': [0xFFD700, 0xFF85A1, 0xDAA520],
	};

	function getTheme() {
		return document.documentElement.getAttribute('data-theme') || 'warm-light';
	}

	// ── Setup overlay renderer (only when needed) ──
	function ensureRenderer() {
		if (isReady) return true;
		if (typeof THREE === 'undefined') return false;

		// Check if 3D is disabled
		const pref = localStorage.getItem('comtrua-3d-effects');
		if (pref === 'off') return false;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;

		fxScene = new THREE.Scene();
		fxCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
		fxCamera.position.z = 20;

		fxRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
		fxRenderer.setSize(window.innerWidth, window.innerHeight);
		fxRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
		fxRenderer.setClearColor(0x000000, 0);

		const canvas = fxRenderer.domElement;
		canvas.id = 'three-fx-canvas';
		canvas.style.cssText = `
			position: fixed;
			top: 0; left: 0;
			width: 100%; height: 100%;
			z-index: 999;
			pointer-events: none;
		`;
		document.body.appendChild(canvas);

		fxClock = new THREE.Clock();

		window.addEventListener('resize', () => {
			if (!fxRenderer || !fxCamera) return;
			fxCamera.aspect = window.innerWidth / window.innerHeight;
			fxCamera.updateProjectionMatrix();
			fxRenderer.setSize(window.innerWidth, window.innerHeight);
		}, { passive: true });

		isReady = true;
		return true;
	}

	// ── Dispose overlay when all effects done ──
	function tryDispose() {
		if (activeSystems.length > 0) return;

		if (fxAnimFrameId) {
			cancelAnimationFrame(fxAnimFrameId);
			fxAnimFrameId = null;
		}

		if (fxRenderer) {
			const canvas = document.getElementById('three-fx-canvas');
			if (canvas) canvas.remove();
			fxRenderer.dispose();
			fxRenderer = null;
		}

		fxScene = null;
		fxCamera = null;
		isReady = false;
	}

	// ── FX Animation Loop ──
	function fxAnimate() {
		if (activeSystems.length === 0) {
			tryDispose();
			return;
		}

		fxAnimFrameId = requestAnimationFrame(fxAnimate);
		const delta = fxClock.getDelta();
		const elapsed = fxClock.getElapsedTime();

		// Update all active particle systems
		for (let i = activeSystems.length - 1; i >= 0; i--) {
			const sys = activeSystems[i];
			sys.age += delta;

			if (sys.age > sys.lifetime) {
				// Remove system
				sys.particles.forEach(p => {
					p.geometry.dispose();
					p.material.dispose();
					fxScene.remove(p);
				});
				activeSystems.splice(i, 1);
				continue;
			}

			// Update particles
			const progress = sys.age / sys.lifetime;
			const fadeOut = Math.max(0, 1 - progress * progress);

			sys.particles.forEach(p => {
				const d = p.userData;

				// Physics
				d.vy -= d.gravity * delta;
				p.position.x += d.vx * delta;
				p.position.y += d.vy * delta;
				p.position.z += d.vz * delta;

				// Rotation
				p.rotation.x += d.rotX * delta;
				p.rotation.y += d.rotY * delta;
				p.rotation.z += d.rotZ * delta;

				// Fade out
				p.material.opacity = d.baseOpacity * fadeOut;

				// Scale down
				const scaleDown = 1 - progress * 0.3;
				p.scale.setScalar(scaleDown);
			});
		}

		fxRenderer.render(fxScene, fxCamera);
	}

	// ── Start FX loop if not running ──
	function ensureRunning() {
		if (!fxAnimFrameId && activeSystems.length > 0) {
			fxClock = new THREE.Clock();
			fxAnimate();
		}
	}

	// ══════════════════════════════════
	// PUBLIC EFFECTS
	// ══════════════════════════════════

	return {
		/**
		 * Confetti burst — triggered on successful order
		 */
		confetti(options = {}) {
			if (!ensureRenderer()) return;

			const theme = getTheme();
			const colors = CONFETTI_COLORS[theme] || CONFETTI_COLORS['warm-light'];
			const count = options.count || (window.innerWidth < 768 ? 30 : 60);
			const system = {
				age: 0,
				lifetime: options.duration || 3,
				particles: [],
			};

			for (let i = 0; i < count; i++) {
				const color = colors[Math.floor(Math.random() * colors.length)];
				const size = 0.08 + Math.random() * 0.18;

				// Mix of shapes
				const shapeRand = Math.random();
				let geometry;
				if (shapeRand < 0.33) {
					geometry = new THREE.BoxGeometry(size * 1.5, size, size * 0.1);
				} else if (shapeRand < 0.66) {
					geometry = new THREE.PlaneGeometry(size * 1.2, size * 0.8);
				} else {
					geometry = new THREE.CircleGeometry(size * 0.5, 6);
				}

				const material = new THREE.MeshBasicMaterial({
					color,
					transparent: true,
					opacity: 0.85 + Math.random() * 0.15,
					side: THREE.DoubleSide,
				});

				const mesh = new THREE.Mesh(geometry, material);

				// Start position (center-top of screen)
				const startX = options.x || 0;
				const startY = options.y || 5;
				mesh.position.set(
					startX + (Math.random() - 0.5) * 4,
					startY + Math.random() * 3,
					(Math.random() - 0.5) * 5
				);

				mesh.userData = {
					vx: (Math.random() - 0.5) * 12,
					vy: 5 + Math.random() * 10,
					vz: (Math.random() - 0.5) * 4,
					gravity: 12 + Math.random() * 6,
					rotX: (Math.random() - 0.5) * 10,
					rotY: (Math.random() - 0.5) * 10,
					rotZ: (Math.random() - 0.5) * 8,
					baseOpacity: material.opacity,
				};

				fxScene.add(mesh);
				system.particles.push(mesh);
			}

			activeSystems.push(system);
			ensureRunning();
		},

		/**
		 * Coin rain — triggered on successful payment
		 */
		coinRain(options = {}) {
			if (!ensureRenderer()) return;

			const theme = getTheme();
			const colors = COIN_COLORS[theme] || COIN_COLORS['warm-light'];
			const count = options.count || (window.innerWidth < 768 ? 15 : 30);
			const system = {
				age: 0,
				lifetime: options.duration || 3.5,
				particles: [],
			};

			for (let i = 0; i < count; i++) {
				const color = colors[Math.floor(Math.random() * colors.length)];
				const size = 0.15 + Math.random() * 0.15;

				// Coin = flattened cylinder
				const geometry = new THREE.CylinderGeometry(size, size, size * 0.08, 12);
				const material = new THREE.MeshBasicMaterial({
					color,
					transparent: true,
					opacity: 0.9,
				});

				const mesh = new THREE.Mesh(geometry, material);

				// Rain from top
				mesh.position.set(
					(Math.random() - 0.5) * 20,
					12 + Math.random() * 8,
					(Math.random() - 0.5) * 6
				);

				// Tilt coins sideways
				mesh.rotation.x = Math.PI / 2;

				mesh.userData = {
					vx: (Math.random() - 0.5) * 2,
					vy: -(3 + Math.random() * 4),
					vz: (Math.random() - 0.5) * 1,
					gravity: 4 + Math.random() * 3,
					rotX: (Math.random() - 0.5) * 4,
					rotY: 3 + Math.random() * 5, // Fast spin around coin axis
					rotZ: (Math.random() - 0.5) * 2,
					baseOpacity: 0.9,
				};

				fxScene.add(mesh);
				system.particles.push(mesh);
			}

			activeSystems.push(system);
			ensureRunning();
		},

		/**
		 * Sparkle burst — generic celebration (smaller, quicker)
		 */
		sparkle(options = {}) {
			if (!ensureRenderer()) return;

			const theme = getTheme();
			const colors = CONFETTI_COLORS[theme] || CONFETTI_COLORS['warm-light'];
			const count = options.count || 20;
			const system = {
				age: 0,
				lifetime: options.duration || 1.5,
				particles: [],
			};

			for (let i = 0; i < count; i++) {
				const color = colors[Math.floor(Math.random() * colors.length)];
				const size = 0.04 + Math.random() * 0.08;

				const geometry = new THREE.SphereGeometry(size, 6, 6);
				const material = new THREE.MeshBasicMaterial({
					color,
					transparent: true,
					opacity: 0.7 + Math.random() * 0.3,
				});

				const mesh = new THREE.Mesh(geometry, material);
				const angle = Math.random() * Math.PI * 2;
				const force = 3 + Math.random() * 6;

				mesh.position.set(
					options.x || 0,
					options.y || 0,
					0
				);

				mesh.userData = {
					vx: Math.cos(angle) * force,
					vy: Math.sin(angle) * force,
					vz: (Math.random() - 0.5) * 3,
					gravity: 6 + Math.random() * 4,
					rotX: Math.random() * 5,
					rotY: Math.random() * 5,
					rotZ: Math.random() * 5,
					baseOpacity: material.opacity,
				};

				fxScene.add(mesh);
				system.particles.push(mesh);
			}

			activeSystems.push(system);
			ensureRunning();
		}
	};
})();
