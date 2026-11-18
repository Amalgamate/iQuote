import { useCallback, useRef, useState } from 'react'
import { apiRequest, assetUrl } from './api'

type LogoUploadProps = {
  logoUrl: string | null
  onUploaded: (logoUrl: string) => void
  onRemoved: () => void
}

const ACCEPTED = '.png,.jpg,.jpeg,.webp,.svg,.gif'
const MAX_SIZE = 5 * 1024 * 1024

export default function LogoUpload({ logoUrl, onUploaded, onRemoved }: LogoUploadProps) {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const uploadFile = useCallback(async (file: File) => {
    setError('')

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (PNG, JPEG, WebP, SVG, or GIF).')
      return
    }

    if (file.size > MAX_SIZE) {
      setError('File is too large. Maximum 5 MB.')
      return
    }

    setUploading(true)
    try {
      // Send raw binary with the correct Content-Type
      const response = await apiRequest<{ logoUrl: string }>('/api/settings/logo', {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      onUploaded(response.logoUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }, [onUploaded])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void uploadFile(file)
  }, [uploadFile])

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void uploadFile(file)
    event.target.value = ''
  }, [uploadFile])

  const handleRemove = useCallback(async () => {
    setError('')
    setUploading(true)
    try {
      await apiRequest('/api/settings/logo', { method: 'DELETE' })
      onRemoved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove logo.')
    } finally {
      setUploading(false)
    }
  }, [onRemoved])

  const resolvedUrl = assetUrl(logoUrl)

  return (
    <div className="logo-upload-section">
      <label className="settings-label">Business logo</label>
      <p className="settings-hint">Upload a PNG, JPEG, WebP, SVG, or GIF. Maximum 5&nbsp;MB.</p>

      <div className="logo-upload-row">
        <div
          className={`logo-dropzone ${dragging ? 'dragging' : ''} ${uploading ? 'uploading' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        >
          {resolvedUrl ? (
            <img src={resolvedUrl} alt="Business logo" className="logo-preview" />
          ) : (
            <div className="logo-dropzone-empty">
              <span className="logo-upload-icon" aria-hidden="true">⬆</span>
              <span>Drag &amp; drop or click to upload</span>
            </div>
          )}
          {uploading && <div className="logo-upload-overlay">Uploading…</div>}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        {resolvedUrl && (
          <button
            type="button"
            className="quiet-button danger-button logo-remove-btn"
            onClick={() => void handleRemove()}
            disabled={uploading}
          >
            Remove
          </button>
        )}
      </div>

      {error && <p className="form-error logo-upload-error" role="alert">{error}</p>}
    </div>
  )
}
