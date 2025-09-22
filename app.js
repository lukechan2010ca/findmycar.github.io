(() => {
    const STORAGE_KEY = 'findmycar_v2_gmaps';

    const mapElement = document.getElementById('map');
    const noteInput = document.getElementById('note');
    const statusEl = document.getElementById('status');
    const photoBtn = document.getElementById('btn-photo');
    const fileInput = document.getElementById('photo-input');
    const previewWrapper = document.getElementById('photo-preview-wrapper');
    const previewImg = document.getElementById('photo-preview');
    const removePhotoBtn = document.getElementById('btn-remove-photo');
    const saveBtn = document.getElementById('btn-save');
    const navigateBtn = document.getElementById('btn-navigate');
    const timeLimitInput = document.getElementById('time-limit');
    const timerDisplay = document.getElementById('timer-display');
    const timerText = document.getElementById('timer-text');
    const timerBar = document.getElementById('timer-bar');
    const stopTimerBtn = document.getElementById('btn-stop-timer');
    const openGmapsLink = document.getElementById('link-open-gmaps');
    const clearAllBtn = document.getElementById('btn-clear-all');

    /** @type {google.maps.Map} */
    let map;
    /** @type {google.maps.Marker | null} */
    let currentMarker = null;
    /** @type {google.maps.Marker | null} */
    let parkedMarker = null;
    /** @type {google.maps.DirectionsService} */
    let directionsService;
    /** @type {google.maps.DirectionsRenderer} */
    let directionsRenderer;
    let parkedSetManually = false;
    
    // Timer variables
    let timerInterval = null;
    let timerStartTime = null;
    let timerDuration = null;
    let warningShown = false;

    function setStatus(message) { statusEl.textContent = message || ''; }
    function readSaved() { try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
    function writeSaved(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

    async function toDataUrl(file, maxSize = 1280) {
        try {
            const img = new Image();
            const reader = new FileReader();
            
            // Read file as data URL
            const dataUrl = await new Promise((resolve, reject) => { 
                reader.onload = () => resolve(reader.result); 
                reader.onerror = reject; 
                reader.readAsDataURL(file); 
            });
            
            // Load image to get dimensions
            img.src = dataUrl;
            await new Promise((resolve, reject) => { 
                img.onload = () => resolve(); 
                img.onerror = reject; 
            });
            
            // Create canvas and resize
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            
            // Return compressed image (fixed typo: toDataURL not toDataUrl)
            return canvas.toDataURL('image/jpeg', 0.8);
        } catch (error) {
            console.error('Photo processing error:', error);
            throw new Error(`Failed to process photo: ${error.message}`);
        }
    }

    // Timer functions
    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    function showNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23ef4444"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>' });
        }
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function updateTimerDisplay() {
        if (!timerStartTime || !timerDuration) return;
        
        const elapsed = Math.floor((Date.now() - timerStartTime) / 1000);
        const remaining = Math.max(0, timerDuration - elapsed);
        const progress = Math.max(0, (timerDuration - remaining) / timerDuration * 100);
        
        timerText.textContent = `Time remaining: ${formatTime(remaining)}`;
        timerBar.style.width = `${progress}%`;
        
        // Show warning at 15 minutes (900 seconds)
        if (remaining <= 900 && remaining > 0 && !warningShown) {
            warningShown = true;
            showNotification('Parking Alert', '15 minutes left on your parking timer!');
            setStatus('⚠️ 15 minutes left on parking timer!');
        }
        
        // Timer expired
        if (remaining <= 0) {
            stopTimer();
            showNotification('Parking Expired', 'Your parking time has expired!');
            setStatus('⏰ Parking time expired!');
        }
    }

    function startTimer() {
        const minutes = parseInt(timeLimitInput.value);
        if (!minutes || minutes < 1) {
            setStatus('Please enter a valid time limit (1-480 minutes)');
            return;
        }
        
        timerDuration = minutes * 60;
        timerStartTime = Date.now();
        warningShown = false;
        
        timerDisplay.hidden = false;
        timeLimitInput.disabled = true;
        
        updateTimerDisplay();
        timerInterval = setInterval(updateTimerDisplay, 1000);
        
        setStatus(`Timer started: ${minutes} minutes`);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        
        timerDisplay.hidden = true;
        timeLimitInput.disabled = false;
        timerStartTime = null;
        timerDuration = null;
        warningShown = false;
        
        setStatus('Timer stopped');
    }

    function updateCurrentMarker(lat, lng) {
        const pos = { lat, lng };
        if (!currentMarker) {
            currentMarker = new google.maps.Marker({ position: pos, map, title: 'You are here' });
        } else {
            currentMarker.setPosition(pos);
        }
    }

    function updateParkedMarker(lat, lng) {
        const pos = { lat, lng };
        if (!parkedMarker) {
            parkedMarker = new google.maps.Marker({ position: pos, map, title: 'Parked car', label: '🚗' });
        } else {
            parkedMarker.setPosition(pos);
        }
    }

    function fitBoundsIfPossible() {
        const bounds = new google.maps.LatLngBounds();
        let has = false;
        if (currentMarker) { bounds.extend(currentMarker.getPosition()); has = true; }
        if (parkedMarker) { bounds.extend(parkedMarker.getPosition()); has = true; }
        if (has) { map.fitBounds(bounds, 60); }
    }

    async function getCurrentPosition(opts) {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('No geolocation'));
            navigator.geolocation.getCurrentPosition(resolve, reject, opts || { enableHighAccuracy: true, timeout: 12000 });
        });
    }

    async function saveLocation() {
        setStatus('Saving...');
        const note = noteInput.value.trim();
        let lat = null, lng = null, accuracy = null;

        try {
            const position = await getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 });
            lat = position.coords.latitude; lng = position.coords.longitude; accuracy = position.coords.accuracy;
        } catch (e) {
            if (parkedSetManually && parkedMarker) {
                const p = parkedMarker.getPosition(); lat = p.lat(); lng = p.lng();
            } else {
                setStatus('Could not get location. Tap the map to set your parked spot, then Save.');
                return;
            }
        }

        const photoDataUrl = previewImg.src || '';
        writeSaved({ parked: { lat, lng, accuracy }, note, photoDataUrl, savedAt: new Date().toISOString() });
        updateParkedMarker(lat, lng);
        fitBoundsIfPossible();
        parkedSetManually = false;
        
        // Start timer only if time limit is set
        const minutes = parseInt(timeLimitInput.value);
        if (minutes && minutes >= 1) {
            startTimer();
            setStatus('Parked location saved and timer started.');
        } else {
            setStatus('Parked location saved.');
        }
    }

    async function navigateToCar() {
        const saved = readSaved();
        if (!saved || !saved.parked) { setStatus('No parked location saved yet.'); return; }

        // Always show directions inside the embedded map (web app)
        let origin;
        try {
            const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
            origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        } catch {
            if (currentMarker) {
                const p = currentMarker.getPosition(); origin = { lat: p.lat(), lng: p.lng() };
            } else { setStatus('Need your current location for directions.'); return; }
        }
        const destination = { lat: saved.parked.lat, lng: saved.parked.lng };
        directionsService.route({ origin, destination, travelMode: google.maps.TravelMode.WALKING }, (result, status) => {
            if (status === 'OK' && result) {
                directionsRenderer.setDirections(result);
                setStatus('Showing walking route to your car.');
            } else {
                setStatus('Could not compute route.');
            }
        });
    }

    function openInGoogleMapsApp(e) {
        if (e && e.preventDefault) e.preventDefault();
        const saved = readSaved();
        if (!saved || !saved.parked) { setStatus('No parked location saved yet.'); return; }
        const destLat = saved.parked.lat;
        const destLng = saved.parked.lng;

        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isAndroid = /Android/.test(navigator.userAgent);

        if (isIOS) {
            const gmapsUrl = `comgooglemaps://?daddr=${destLat},${destLng}&directionsmode=walking`;
            const universal = `https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}&travelmode=walking`;
            openGmapsLink.setAttribute('href', gmapsUrl);
            setTimeout(() => { window.location.href = universal; }, 1200);
            return;
        }

        if (isAndroid) {
            const intentUrl = `intent://maps.google.com/maps?daddr=${destLat},${destLng}&directionsmode=walking#Intent;scheme=https;package=com.google.android.apps.maps;end`;
            try { window.location.href = intentUrl; } catch { window.location.href = `https://maps.google.com/?daddr=${destLat},${destLng}`; }
            return;
        }

        // Desktop fallback to web
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}&travelmode=walking`, '_blank');
    }

    function clearPhoto() { previewImg.src = ''; previewWrapper.hidden = true; }

    function clearAllData() {
        // Show confirmation dialog
        if (!confirm('Are you sure you want to clear all data? This will remove your parked location, notes, photos, and timer settings.')) {
            return;
        }

        // Stop timer if running
        stopTimer();

        // Clear localStorage
        localStorage.removeItem(STORAGE_KEY);

        // Reset form inputs
        noteInput.value = '';
        timeLimitInput.value = '';
        timeLimitInput.disabled = false;

        // Clear photo
        clearPhoto();

        // Remove markers from map
        if (parkedMarker) {
            parkedMarker.setMap(null);
            parkedMarker = null;
        }

        // Clear directions if showing
        if (directionsRenderer) {
            directionsRenderer.setDirections({ routes: [] });
        }

        // Reset manual flag
        parkedSetManually = false;

        // Show success message
        setStatus('All data cleared successfully');
        
        // Clear status after 3 seconds
        setTimeout(() => setStatus(''), 3000);
    }

    function hydrateFromSaved() {
        const saved = readSaved();
        if (!saved) return;
        if (saved.note) noteInput.value = saved.note;
        if (saved.photoDataUrl) { previewImg.src = saved.photoDataUrl; previewWrapper.hidden = false; }
        if (saved.parked && typeof saved.parked.lat === 'number' && typeof saved.parked.lng === 'number') {
            updateParkedMarker(saved.parked.lat, saved.parked.lng);
        }
    }

    function initMap() {
        map = new google.maps.Map(mapElement, { center: { lat: 0, lng: 0 }, zoom: 2, mapTypeControl: false, fullscreenControl: false });
        directionsService = new google.maps.DirectionsService();
        directionsRenderer = new google.maps.DirectionsRenderer({ map });

        // Click to set parked spot
        map.addListener('click', (e) => {
            const lat = e.latLng.lat(); const lng = e.latLng.lng();
            updateParkedMarker(lat, lng);
            parkedSetManually = true;
            setStatus('Parked spot set from map. Tap Save to store.');
        });

        // try to center on current position
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
                const lat = pos.coords.latitude, lng = pos.coords.longitude;
                map.setCenter({ lat, lng }); map.setZoom(16);
                updateCurrentMarker(lat, lng);
            }, () => { setStatus('Location permission denied. You can still tap the map to set spot.'); }, { enableHighAccuracy: true, timeout: 10000 });

            navigator.geolocation.watchPosition((pos) => {
                updateCurrentMarker(pos.coords.latitude, pos.coords.longitude);
            }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
        }

        hydrateFromSaved();
        fitBoundsIfPossible();
    }
    // Expose for Google Maps callback
    window.initMap = initMap;

    // Events
    photoBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0]; 
        if (!file) return;
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
            setStatus('Please select an image file');
            return;
        }
        
        setStatus('Processing photo...');
        try { 
            const dataUrl = await toDataUrl(file); 
            previewImg.src = dataUrl; 
            previewWrapper.hidden = false; 
            
            // Save photo immediately to localStorage
            const saved = readSaved() || {};
            saved.photoDataUrl = dataUrl;
            writeSaved(saved);
            
            setStatus('Photo saved');
        }
        catch (error) { 
            console.error('Photo processing failed:', error);
            setStatus(`Failed to process photo: ${error.message}`);
        }
    });

    // Check if camera access is available
    function checkCameraSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setStatus('Camera not supported. Please use HTTPS or a modern browser.');
            return false;
        }
        return true;
    }

    // Add camera support check on load
    if (!checkCameraSupport()) {
        photoBtn.disabled = true;
        photoBtn.textContent = 'Camera Not Available';
    }
    removePhotoBtn.addEventListener('click', () => { clearPhoto(); const saved = readSaved(); if (saved) { saved.photoDataUrl = ''; writeSaved(saved); } });
    saveBtn.addEventListener('click', saveLocation);
    navigateBtn.addEventListener('click', navigateToCar);
    stopTimerBtn.addEventListener('click', stopTimer);
    openGmapsLink.addEventListener('click', openInGoogleMapsApp);
    clearAllBtn.addEventListener('click', clearAllData);
    
    // Request notification permission on load
    requestNotificationPermission();
})();