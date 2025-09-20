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
        const img = new Image();
        const reader = new FileReader();
        const dataUrl = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        img.src = dataUrl;
        await new Promise((r, j) => { img.onload = () => r(); img.onerror = j; });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataUrl('image/jpeg', 0.8);
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
        const minutes = parseInt(timeLimitInput.value) || 60;
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
        
        // Start timer when parking location is saved
        startTimer();
        setStatus('Parked location saved and timer started.');
    }

    async function navigateToCar() {
        const saved = readSaved();
        if (!saved || !saved.parked) { setStatus('No parked location saved yet.'); return; }
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

        directionsService.route({
            origin, destination, travelMode: google.maps.TravelMode.WALKING
        }, (result, status) => {
            if (status === 'OK' && result) {
                directionsRenderer.setDirections(result);
                setStatus('Showing walking route to your car.');
            } else {
                setStatus('Could not compute route.');
            }
        });
    }

    function clearPhoto() { previewImg.src = ''; previewWrapper.hidden = true; }

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
        const file = e.target.files && e.target.files[0]; if (!file) return;
        setStatus('Processing photo...');
        try { const dataUrl = await toDataUrl(file); previewImg.src = dataUrl; previewWrapper.hidden = false; setStatus(''); }
        catch { setStatus('Failed to process photo.'); }
    });
    removePhotoBtn.addEventListener('click', () => { clearPhoto(); const saved = readSaved(); if (saved) { saved.photoDataUrl = ''; writeSaved(saved); } });
    saveBtn.addEventListener('click', saveLocation);
    navigateBtn.addEventListener('click', navigateToCar);
    stopTimerBtn.addEventListener('click', stopTimer);
    
    // Request notification permission on load
    requestNotificationPermission();
})();