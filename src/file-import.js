export function setupFileImport({ dropZone, fileInput, addTrackFromArrayBuffer, setStatus }) {
    async function loadFile(file) {
        if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|ogg|flac|aac|m4a|webm)$/i)) {
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const name = file.name.replace(/\.[^/.]+$/, '');
                await addTrackFromArrayBuffer(reader.result, name);
            } catch (err) {
                console.error('Failed to decode audio:', err);
                setStatus(`Error: ${err.message}`);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    async function handleFiles(files) {
        for (const file of files) {
            await loadFile(file);
        }
    }

    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFiles(fileInput.files);
        fileInput.value = '';
    });

    dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    document.body.addEventListener('dragover', e => e.preventDefault());
    document.body.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
}
