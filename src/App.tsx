import { useState, useEffect, useRef, useCallback } from 'react'
import L from 'leaflet'

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow })

// ── Types ────────────────────────────────────────────────────────────────────

type View = 'input' | 'results'

interface FormData {
  location: string
  locationLat: number | null
  locationLng: number | null
  tripStart: string
  tripEnd: string
  station: string
  boardingTime: string
  margin: number  // minutes before boarding to arrive at station
}

interface Place {
  id: string
  name: string
  emoji: string
  walkMin: number
  lat: number
  lng: number
  tags: Record<string, string>
  kind: 'spot' | 'food'
  subtitle: string
}

// ── Utilities ────────────────────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
function minutesToTime(m: number): string {
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}
function formatMinutes(m: number): string {
  if (m < 60) return `${m}分`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}時間` : `${h}時間${rem}分`
}

// Haversine distance in metres
function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Walking time in minutes at 80 m/min
function walkMinutes(dist: number): number {
  return Math.ceil(dist / 80)
}

// ── Overpass API ─────────────────────────────────────────────────────────────

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

async function fetchOverpass(query: string): Promise<any[]> {
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!res.ok) throw new Error(`Overpass ${res.status}`)
  const json = await res.json()
  return json.elements ?? []
}

function elementCoord(el: any): { lat: number; lng: number } | null {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon }
  if (el.center) return { lat: el.center.lat, lng: el.center.lon }
  return null
}

function nameOf(tags: Record<string, string>): string {
  return tags['name:ja'] || tags.name || ''
}

// Food emoji mapping
function foodEmoji(tags: Record<string, string>): string {
  const a = tags.amenity ?? ''
  const cuisine = (tags.cuisine ?? '').toLowerCase()
  if (cuisine.includes('sushi') || cuisine.includes('寿司')) return '🍣'
  if (cuisine.includes('ramen') || cuisine.includes('ラーメン')) return '🍜'
  if (cuisine.includes('soba') || cuisine.includes('そば') || cuisine.includes('udon')) return '🍝'
  if (cuisine.includes('tempura') || cuisine.includes('天ぷら')) return '🍤'
  if (cuisine.includes('yakitori') || cuisine.includes('焼き鳥')) return '🍢'
  if (cuisine.includes('pizza')) return '🍕'
  if (cuisine.includes('burger') || cuisine.includes('hamburger')) return '🍔'
  if (a === 'cafe') return '☕'
  if (a === 'fast_food') return '🍟'
  if (a === 'bar' || a === 'pub' || a === 'izakaya') return '🍺'
  if (a === 'ice_cream') return '🍦'
  return '🍽️'
}

// Spot emoji mapping
function spotEmoji(tags: Record<string, string>): string {
  const t = tags.tourism ?? ''
  const h = tags.historic ?? ''
  const l = tags.leisure ?? ''
  const n = tags.natural ?? ''
  if (h === 'castle' || h === 'castle_ruins') return '🏯'
  if (h === 'temple' || h === 'shrine') return '⛩️'
  if (h === 'monument' || h === 'memorial') return '🗿'
  if (h === 'archaeological_site' || h === 'ruins') return '🏚️'
  if (h) return '🏛️'
  if (t === 'museum') return '🖼️'
  if (t === 'gallery') return '🎨'
  if (t === 'viewpoint') return '🗼'
  if (t === 'zoo') return '🦁'
  if (t === 'theme_park') return '🎡'
  if (t === 'aquarium') return '🐟'
  if (t === 'hot_spring' || t === 'onsen') return '♨️'
  if (t === 'artwork') return '🖼️'
  if (l === 'park') return '🌿'
  if (l === 'garden') return '🌸'
  if (l === 'nature_reserve' || n) return '🌲'
  if (l === 'sports_centre') return '🏟️'
  return '📍'
}

// Food subtitle
function foodSubtitle(tags: Record<string, string>): string {
  const parts: string[] = []
  if (tags.cuisine) parts.push(tags.cuisine.replace(';', '・'))
  if (tags['opening_hours']) parts.push(tags['opening_hours'])
  if (tags['addr:housenumber'] && tags['addr:street']) parts.push(`${tags['addr:street']} ${tags['addr:housenumber']}`)
  return parts.join(' ／ ')
}

// Spot subtitle
function spotSubtitle(tags: Record<string, string>): string {
  const parts: string[] = []
  const labels: Record<string, string> = {
    museum: '博物館・美術館', viewpoint: '展望スポット', park: '公園',
    garden: '庭園', castle: '城', shrine: '神社', temple: '寺院',
    ruins: '遺跡・廃墟', archaeological_site: '史跡', monument: '記念碑',
    gallery: 'ギャラリー', zoo: '動物園', aquarium: '水族館',
    theme_park: 'テーマパーク', hot_spring: '温泉',
    nature_reserve: '自然保護区',
  }
  const key = tags.tourism || tags.historic || tags.leisure || tags.natural || ''
  if (labels[key]) parts.push(labels[key])
  if (tags['opening_hours']) parts.push(tags['opening_hours'])
  if (tags.fee === 'yes') parts.push('有料')
  else if (tags.fee === 'no') parts.push('無料')
  return parts.join(' ／ ')
}

async function fetchFoodPlaces(lat: number, lng: number, radiusM: number): Promise<Place[]> {
  const query = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream|bakery)$"](around:${radiusM},${lat},${lng});
  way["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|bakery)$"](around:${radiusM},${lat},${lng});
  relation["amenity"~"^(restaurant|cafe|fast_food)$"](around:${radiusM},${lat},${lng});
);
out center tags;`
  const elements = await fetchOverpass(query)
  const results: Place[] = []
  for (const el of elements) {
    const tags: Record<string, string> = el.tags ?? {}
    const name = nameOf(tags)
    if (!name) continue
    const coord = elementCoord(el)
    if (!coord) continue
    const dist = distanceM(lat, lng, coord.lat, coord.lng)
    results.push({
      id: `f_${el.type}_${el.id}`,
      name,
      emoji: foodEmoji(tags),
      walkMin: walkMinutes(dist),
      lat: coord.lat,
      lng: coord.lng,
      tags,
      kind: 'food',
      subtitle: foodSubtitle(tags),
    })
  }
  return results.sort((a, b) => a.walkMin - b.walkMin)
}

async function fetchSpotPlaces(lat: number, lng: number, radiusM: number): Promise<Place[]> {
  const query = `
[out:json][timeout:30];
(
  node["tourism"~"^(museum|gallery|viewpoint|zoo|aquarium|theme_park|artwork|hot_spring|attraction)$"](around:${radiusM},${lat},${lng});
  node["historic"~"^(castle|castle_ruins|temple|shrine|monument|memorial|archaeological_site|ruins|building|wayside_shrine)$"](around:${radiusM},${lat},${lng});
  node["leisure"~"^(park|garden|nature_reserve|sports_centre)$"](around:${radiusM},${lat},${lng});
  node["natural"~"^(peak|waterfall|spring|cave_entrance|wood)$"](around:${radiusM},${lat},${lng});
  way["tourism"~"^(museum|gallery|viewpoint|zoo|aquarium|theme_park|attraction|castle)$"](around:${radiusM},${lat},${lng});
  way["historic"~"^(castle|castle_ruins|temple|shrine|ruins|archaeological_site)$"](around:${radiusM},${lat},${lng});
  way["leisure"~"^(park|garden|nature_reserve)$"](around:${radiusM},${lat},${lng});
);
out center tags;`
  const elements = await fetchOverpass(query)
  const results: Place[] = []
  for (const el of elements) {
    const tags: Record<string, string> = el.tags ?? {}
    const name = nameOf(tags)
    if (!name) continue
    const coord = elementCoord(el)
    if (!coord) continue
    const dist = distanceM(lat, lng, coord.lat, coord.lng)
    results.push({
      id: `s_${el.type}_${el.id}`,
      name,
      emoji: spotEmoji(tags),
      walkMin: walkMinutes(dist),
      lat: coord.lat,
      lng: coord.lng,
      tags,
      kind: 'spot',
      subtitle: spotSubtitle(tags),
    })
  }
  return results.sort((a, b) => a.walkMin - b.walkMin)
}

// ── Favorites ─────────────────────────────────────────────────────────────────

const FAV_KEY = 'shucchou_tsuide_favs'
function loadFavs(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')) }
  catch { return new Set() }
}
function saveFavs(favs: Set<string>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...favs]))
}

// ── Dark mode ─────────────────────────────────────────────────────────────────

const DARK_KEY = 'shucchou_tsuide_dark'
function loadDark(): boolean {
  const saved = localStorage.getItem(DARK_KEY)
  if (saved !== null) return saved === 'true'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// ── Map component ─────────────────────────────────────────────────────────────

interface MapViewProps {
  baseLat: number; baseLng: number
  stationLat: number | null; stationLng: number | null; stationName: string
  spots: Place[]; foods: Place[]
  favorites: Set<string>
  radiusM: number
  onSelectPlace: (p: Place | null) => void
  selectedId: string | null
}

function MapView({ baseLat, baseLng, stationLat, stationLng, stationName, spots, foods, favorites, radiusM, onSelectPlace, selectedId }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const allPlaces = [...spots, ...foods]

  // Rebuild marker icons when favorites change
  const refreshMarkerIcons = useCallback((fav: Set<string>) => {
    markersRef.current.forEach((marker, id) => {
      const place = allPlaces.find(p => p.id === id)
      if (!place) return
      const isFav = fav.has(id)
      const bg = isFav ? '#c85c2e' : (place.kind === 'spot' ? '#1a2e4a' : '#2d6a4f')
      const radius = place.kind === 'spot' ? '50%' : '10px'
      marker.setIcon(L.divIcon({
        className: '',
        html: `<div style="width:36px;height:36px;border-radius:${radius};background:${bg};border:2.5px solid white;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${place.emoji}</div>`,
        iconSize: [36, 36], iconAnchor: [18, 18],
      }))
    })
  }, [allPlaces])

  useEffect(() => {
    refreshMarkerIcons(favorites)
  }, [favorites, refreshMarkerIcons])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: false }).setView([baseLat, baseLng], 15)
    mapRef.current = map

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.control.attribution({ prefix: '© OpenStreetMap' }).addTo(map)

    // Walking radius circle (subtle)
    L.circle([baseLat, baseLng], {
      radius: radiusM,
      color: '#c85c2e',
      weight: 1.5,
      opacity: 0.35,
      fillColor: '#c85c2e',
      fillOpacity: 0.05,
      dashArray: '6 4',
    }).addTo(map)

    // Selected starting-point pin
    L.marker([baseLat, baseLng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="position:relative;width:22px;height:22px">
          <div style="position:absolute;inset:0;border-radius:50%;background:rgba(200,92,46,0.2);animation:ping 2s cubic-bezier(0,0,0.2,1) infinite"></div>
          <div style="position:absolute;inset:3px;border-radius:50%;background:#c85c2e;border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>
        </div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      }),
      zIndexOffset: 1000,
    }).addTo(map)

    // Station pin
    if (stationLat != null && stationLng != null) {
      L.marker([stationLat, stationLng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:#1a2e4a;border:2.5px solid white;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:700;color:white;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);font-family:'Noto Sans JP',sans-serif">🚉 ${stationName}</div>`,
          iconAnchor: [0, 12],
        }),
        zIndexOffset: 900,
      }).addTo(map)
    }

    // Place pins
    const markers = new Map<string, L.Marker>()
    const addPin = (p: Place) => {
      const isFav = favorites.has(p.id)
      const bg = isFav ? '#c85c2e' : (p.kind === 'spot' ? '#1a2e4a' : '#2d6a4f')
      const radius = p.kind === 'spot' ? '50%' : '10px'
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:36px;height:36px;border-radius:${radius};background:${bg};border:2.5px solid white;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,0.3)">${p.emoji}</div>`,
        iconSize: [36, 36], iconAnchor: [18, 18],
      })
      const marker = L.marker([p.lat, p.lng], { icon }).addTo(map)
      marker.on('click', () => onSelectPlace(p))
      markers.set(p.id, marker)
    }
    allPlaces.forEach(addPin)
    markersRef.current = markers

    // Fit bounds to all points
    const coords: [number, number][] = [
      [baseLat, baseLng],
      ...(stationLat != null && stationLng != null ? [[stationLat, stationLng] as [number, number]] : []),
      ...allPlaces.map(p => [p.lat, p.lng] as [number, number]),
    ]
    if (coords.length > 1) {
      map.fitBounds(L.latLngBounds(coords).pad(0.15))
    }

    // Tap map background to deselect
    map.on('click', () => onSelectPlace(null))

    // Ensure Leaflet recalculates size after layout settles
    setTimeout(() => map.invalidateSize(), 50)

    return () => { map.remove(); mapRef.current = null; markersRef.current = new Map() }
  }, [])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

// CSS ping animation injected once
const pingStyle = `@keyframes ping{75%,100%{transform:scale(2);opacity:0}}`
if (!document.getElementById('map-ping-style')) {
  const s = document.createElement('style'); s.id = 'map-ping-style'; s.textContent = pingStyle; document.head.appendChild(s)
}

// ── Place card ────────────────────────────────────────────────────────────────

const TAG_COLORS = {
  light: { fee_no: { bg: '#dcfce7', text: '#15803d' }, fee_yes: { bg: '#dbeafe', text: '#1e40af' }, open: { bg: '#fef3c7', text: '#92400e' } },
  dark:  { fee_no: { bg: '#14532d', text: '#86efac' }, fee_yes: { bg: '#1e3a5f', text: '#93c5fd' }, open: { bg: '#451a03', text: '#fcd34d' } },
}

function PlaceCard({ place, isFav, onToggleFav, dark }: { place: Place; isFav: boolean; onToggleFav: () => void; dark: boolean }) {
  const palette = dark ? TAG_COLORS.dark : TAG_COLORS.light
  const feeTag = place.tags.fee === 'no' ? { label: '無料', style: palette.fee_no }
    : place.tags.fee === 'yes' ? { label: '有料', style: palette.fee_yes }
    : null
  const hours = place.tags['opening_hours']

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--card)', border: '1.5px solid var(--border)' }}>
      <div className="flex items-start gap-3">
        <div className="text-2xl w-12 h-12 flex items-center justify-center rounded-xl shrink-0" style={{ background: 'var(--muted)' }}>
          {place.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-semibold text-sm leading-snug" style={{ color: 'var(--foreground)' }}>{place.name}</span>
            {feeTag && <span className="text-xs px-2 py-0.5 rounded-full font-medium shrink-0" style={feeTag.style}>{feeTag.label}</span>}
            <button onClick={onToggleFav} className="text-base transition-all active:scale-90 shrink-0 ml-auto">{isFav ? '❤️' : '🤍'}</button>
          </div>
          {place.subtitle && (
            <p className="text-xs mb-1.5 leading-relaxed" style={{ color: 'var(--accent)' }}>{place.subtitle}</p>
          )}
          {hours && (
            <p className="text-xs mb-1.5" style={{ color: 'var(--muted-foreground)' }}>🕐 {hours}</p>
          )}
          {place.tags.description && (
            <p className="text-xs mb-1.5 leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>{place.tags['description:ja'] || place.tags.description}</p>
          )}
          <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>
            <span>🚶 徒歩{place.walkMin}分</span>
            {place.kind === 'spot' && <span>⏱️ 往復{place.walkMin * 2}分〜</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty({ message }: { message: string }) {
  return (
    <div className="text-center py-14 px-4">
      <p className="text-4xl mb-3">🔍</p>
      <p className="text-sm font-medium mb-1" style={{ color: 'var(--foreground)' }}>{message}</p>
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>エリアを変えるか、検索半径を広げてみてください</p>
    </div>
  )
}

// ── Location search (Photon / OpenStreetMap) ───────────────────────────────────
// 住所・施設名の入力候補は、入力後にPhotonで検索する。
// Nominatimの公開APIはオートコンプリートを禁止しているため、候補表示には使わない。
interface LocationOption {
  id: string
  label: string
  lat: number
  lng: number
}

async function searchLocations(query: string, signal?: AbortSignal): Promise<LocationOption[]> {
  const params = new URLSearchParams({ q: query.trim(), lang: 'default', limit: '6' })
  const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, { signal })
  if (!response.ok) throw new Error(`場所の検索に失敗しました (${response.status})`)
  const result = await response.json()
  const features: any[] = Array.isArray(result.features) ? result.features : []

  return features.flatMap((feature: any, index: number): LocationOption[] => {
    const coords = feature.geometry?.coordinates
    if (!Array.isArray(coords) || coords.length < 2) return []
    const lng = Number(coords[0])
    const lat = Number(coords[1])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
    const props = feature.properties ?? {}
    const parts: string[] = [props.name, props.street, props.city || props.town, props.county, props.state]
      .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
    const label = [...new Set(parts)].join('、') || query.trim()
    return [{ id: `${lat}:${lng}:${index}`, label, lat, lng }]
  })
}

// ── Input Page ────────────────────────────────────────────────────────────────

function InputPage({ onSubmit, dark, onToggleDark }: {
  onSubmit: (data: FormData) => void
  dark: boolean; onToggleDark: () => void
}) {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  const [location, setLocation] = useState('')
  const [locationLat, setLocationLat] = useState<number | null>(null)
  const [locationLng, setLocationLng] = useState<number | null>(null)
  const [tripStart, setTripStart] = useState(`${pad(now.getHours())}:${pad(now.getMinutes())}`)
  const [tripEnd, setTripEnd] = useState(`${pad((now.getHours() + 2) % 24)}:${pad(now.getMinutes())}`)
  const [station, setStation] = useState('')
  const [boardingTime, setBoardingTime] = useState(`${pad((now.getHours() + 3) % 24)}:${pad(now.getMinutes())}`)
  const [margin, setMargin] = useState(30)
  const [customMargin, setCustomMargin] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [gpsLoading, setGpsLoading] = useState(false)
  const [gpsError, setGpsError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [locationSource, setLocationSource] = useState<'gps' | 'manual' | null>(null)
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>([])
  const [locationSearching, setLocationSearching] = useState(false)
  const [locationSearchError, setLocationSearchError] = useState('')
  const [locationResolving, setLocationResolving] = useState(false)
  const locationChangeRef = useRef(0)

  // 候補は入力が止まってから表示。古いリクエストは破棄する。
  // 住所・施設名の候補表示にはPhotonを使用（Nominatimには連続照会しない）。
  useEffect(() => {
    if (locationSource !== null || location.trim().length < 2) {
      setLocationOptions([])
      setLocationSearching(false)
      return
    }
    const controller = new AbortController()
    let active = true
    const timer = window.setTimeout(async () => {
      setLocationSearching(true)
      setLocationSearchError('')
      try {
        const options = await searchLocations(location, controller.signal)
        if (active) setLocationOptions(options)
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setLocationSearchError('場所検索サービスに接続できませんでした。時間をおいて再試行してください')
          setLocationOptions([])
        }
      } finally {
        if (active) setLocationSearching(false)
      }
    }, 650)
    return () => {
      active = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [location, locationSource])

  const handleLocationChange = (value: string) => {
    locationChangeRef.current++
    setLocation(value)
    // GPSで選んだ後に書き換えたら、古い座標を絶対に流用しない。
    setLocationLat(null)
    setLocationLng(null)
    setLocationSource(null)
    setLocationOptions([])
    setLocationSearchError('')
    setGpsError('')
    setGpsLoading(false)
    setErrors(prev => ({ ...prev, location: '' }))
  }

  const handleLocationSelect = (option: LocationOption) => {
    locationChangeRef.current++
    setLocation(option.label)
    setLocationLat(option.lat)
    setLocationLng(option.lng)
    setLocationSource('manual')
    setLocationOptions([])
    setLocationSearchError('')
    setGpsError('')
    setErrors(prev => ({ ...prev, location: '' }))
  }


  const handleGps = () => {
    if (!navigator.geolocation) {
      setGpsError('この端末は位置情報の取得に対応していません。手動で入力してください')
      return
    }
    const requestId = ++locationChangeRef.current
    setGpsLoading(true)
    setGpsError('')
    setLocationSearchError('')
    setLocationOptions([])
    setLocationLat(null)
    setLocationLng(null)
    setLocationSource('gps')

    navigator.geolocation.getCurrentPosition(
      async pos => {
        if (requestId !== locationChangeRef.current) return
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`
        setLocationLat(lat)
        setLocationLng(lng)
        setLocation(fallback)
        setErrors(prev => ({ ...prev, location: '' }))
        // 逆ジオコーディングはGPSボタン押下時の1回のみ。
        try {
          const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`
          const response = await fetch(url)
          if (!response.ok) throw new Error('逆ジオコーディング失敗')
          const data = await response.json()
          if (requestId !== locationChangeRef.current) return
          const a = data.address ?? {}
          const parts = [
            a.road || a.suburb || a.neighbourhood || a.quarter || a.city_district,
            a.city || a.town || a.village || a.hamlet || a.municipality || a.county,
            a.state,
          ].filter(Boolean)
          setLocation([...new Set(parts)].join('、') || fallback)
        } catch {
          // 住所表示が取得できなくてもGPS座標自体は有効。
          if (requestId === locationChangeRef.current) setLocation(fallback)
        } finally {
          if (requestId === locationChangeRef.current) setGpsLoading(false)
        }
      },
      err => {
        if (requestId !== locationChangeRef.current) return
        setGpsLoading(false)
        setLocationSource(null)
        setGpsError(err.code === 1
          ? '位置情報が許可されていません。設定で許可するか、手動で入力してください'
          : '位置情報を取得できませんでした。手動で入力してください')
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    )
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!location.trim()) e.location = '現在地を入力してください'
    if (!station.trim()) e.station = '乗車駅を入力してください'
    if (timeToMinutes(tripEnd) <= timeToMinutes(tripStart)) e.tripEnd = '終了時刻は開始より後にしてください'
    if (timeToMinutes(boardingTime) <= timeToMinutes(tripEnd)) e.boardingTime = '乗車時刻は出張終了より後にしてください'
    return e
  }

  const handleSubmit = async () => {
    if (gpsLoading || locationResolving) return
    const e = validate()
    if (Object.keys(e).length > 0) { setErrors(e); return }

    let lat = locationLat
    let lng = locationLng
    let label = location

    // 候補をタップせずそのまま進んだ場合も、必ず場所名→座標に変換する。
    // 変換できない場所名で東京を代用することはしない。
    if (lat === null || lng === null) {
      const requestId = locationChangeRef.current
      setLocationResolving(true)
      setErrors(prev => ({ ...prev, location: '' }))
      try {
        const matches = await searchLocations(location)
        if (requestId !== locationChangeRef.current) return
        if (!matches.length) {
          setErrors(prev => ({ ...prev, location: '場所を特定できませんでした。住所や駅名を詳しく入力してください' }))
          return
        }
        const chosen = matches[0]
        lat = chosen.lat
        lng = chosen.lng
        label = chosen.label
        setLocation(chosen.label)
        setLocationLat(lat)
        setLocationLng(lng)
        setLocationSource('manual')
        setLocationOptions([])
      } catch {
        if (requestId === locationChangeRef.current) {
          setErrors(prev => ({ ...prev, location: '位置検索に失敗しました。通信状況を確認して再試行してください' }))
        }
        return
      } finally {
        setLocationResolving(false)
      }
    }
    onSubmit({ location: label, locationLat: lat, locationLng: lng, tripStart, tripEnd, station, boardingTime, margin })
  }

  const availableUntilMin = timeToMinutes(boardingTime) - margin
  const freeMin = Math.max(0, availableUntilMin - timeToMinutes(tripEnd))

  const PRESETS = [15, 30, 45, 60]
  const handlePreset = (m: number) => { setMargin(m); setShowCustom(false); setCustomMargin('') }
  const handleCustomCommit = () => {
    const v = parseInt(customMargin, 10)
    if (!isNaN(v) && v >= 0 && v <= 180) setMargin(v)
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--background)' }}>
      <div style={{ background: 'var(--primary)' }} className="px-5 pt-12 pb-6">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗺️</span>
            <span className="text-lg font-bold tracking-wider" style={{ color: 'var(--accent)', fontFamily: 'Outfit, sans-serif' }}>出張ついで</span>
          </div>
          <button onClick={onToggleDark} className="w-9 h-9 rounded-full flex items-center justify-center text-base active:scale-90" style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--primary-foreground)' }}>
            {dark ? '☀️' : '🌙'}
          </button>
        </div>
        <p className="text-sm" style={{ color: 'rgba(245,240,232,0.65)' }}>出張のすきまに、ちょっとだけ寄り道しよう</p>
      </div>

      <div className="flex-1 px-4 py-5 space-y-5 pb-10">
        {/* 現在地・出張先 */}
        <section>
          <label htmlFor="location-input" className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted-foreground)' }}>
            現在地・出張先
          </label>
          <div className="flex gap-2 min-w-0">
            <input id="location-input" type="search" autoComplete="off"
              placeholder="住所・施設・駅を入力（例：松本市役所）"
              value={location} onChange={e => handleLocationChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setLocationOptions([]) }}
              className="min-w-0 flex-1 px-3 py-3 text-sm rounded-xl outline-none"
              style={{ background: 'var(--card)', border: `1.5px solid ${errors.location ? 'var(--accent)' : 'var(--border)'}`, color: 'var(--foreground)' }}
              aria-label="住所、施設名、駅名を入力"
            />
            <button type="button" onClick={handleGps} disabled={gpsLoading}
              aria-label="GPSで現在地を取得" title="GPSで現在地を取得"
              className="shrink-0 w-11 h-11 rounded-xl text-lg flex items-center justify-center active:scale-95 disabled:opacity-50"
              style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              {gpsLoading ? <span className="animate-spin inline-block">⟳</span> : <span>📍</span>}
            </button>
          </div>
          <p className="text-xs mt-1.5" style={{ color: 'var(--muted-foreground)' }}>
            📍 GPSを使うか、場所名から候補を選んでください
          </p>
          {locationSource === null && location.trim().length >= 2 && (
            <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
              {locationSearching && <p className="text-xs px-3 py-3" style={{ color: 'var(--muted-foreground)' }}>🔎 場所を検索中...</p>}
              {!locationSearching && locationOptions.map(option => (
                <button type="button" key={option.id}
                  onClick={() => handleLocationSelect(option)}
                  className="w-full text-left px-3 py-3 text-sm active:opacity-70"
                  style={{ color: 'var(--foreground)', borderBottom: '1px solid var(--border)' }}>
                  📍 {option.label}
                </button>
              ))}
              {!locationSearching && !locationSearchError && locationOptions.length === 0 && (
                <p className="px-3 py-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  候補が出ない場合はそのまま「寄り道スポットを探す」を押せます
                </p>
              )}
            </div>
          )}
          {locationLat !== null && locationLng !== null && (
            <p className="text-xs mt-1.5" style={{ color: 'var(--muted-foreground)' }}>
              ✓ {locationSource === 'gps' ? 'GPS取得済み' : '場所を指定済み'}（{locationLat.toFixed(4)}, {locationLng.toFixed(4)}）
            </p>
          )}
          {locationSearchError && <p className="text-xs mt-1.5" style={{ color: 'var(--accent)' }}>{locationSearchError}</p>}
          {gpsError && <p className="text-xs mt-1.5" style={{ color: 'var(--accent)' }}>{gpsError}</p>}
          {errors.location && <p className="text-xs mt-1.5" role="alert" style={{ color: 'var(--accent)' }}>{errors.location}</p>}
        </section>

        {/* 出張時間 */}
        <section>
          <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted-foreground)' }}>出張時間</label>
          <div className="rounded-xl overflow-hidden" style={{ border: '1.5px solid var(--border)', background: 'var(--card)' }}>
            {([['🚀', '開始', tripStart, (v: string) => setTripStart(v), ''] as const,
               ['🏁', '終了', tripEnd, (v: string) => { setTripEnd(v); setErrors(p => ({...p, tripEnd: ''})) }, 'tripEnd'] as const,
            ]).map(([icon, label, val, onChange, errKey], i) => (
              <div key={i}>
                {i > 0 && <div style={{ height: 1, background: 'var(--border)' }} />}
                <div className="flex items-center px-4 py-3 gap-3">
                  <span>{icon}</span>
                  <span className="text-sm flex-1" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
                  <input type="time" value={val} onChange={e => onChange(e.target.value)} className="text-sm font-medium outline-none" style={{ background: 'transparent', color: errors[errKey] ? 'var(--accent)' : 'var(--foreground)' }} />
                </div>
              </div>
            ))}
          </div>
          {errors.tripEnd && <p className="text-xs mt-1.5" style={{ color: 'var(--accent)' }}>{errors.tripEnd}</p>}
        </section>

        {/* 帰りの電車 */}
        <section>
          <label className="block text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted-foreground)' }}>帰りの電車</label>
          <div className="rounded-xl overflow-hidden mb-3" style={{ border: '1.5px solid var(--border)', background: 'var(--card)' }}>
            <div className="flex items-center px-4 py-3 gap-3">
              <span>🚉</span>
              <input type="text" placeholder="乗車駅（例：金沢駅、松本駅）" value={station}
                onChange={e => { setStation(e.target.value); setErrors(p => ({...p, station: ''})) }}
                className="flex-1 text-sm outline-none" style={{ background: 'transparent', color: 'var(--foreground)' }} />
            </div>
            <div style={{ height: 1, background: 'var(--border)' }} />
            <div className="flex items-center px-4 py-3 gap-3">
              <span>🕐</span>
              <span className="text-sm flex-1" style={{ color: 'var(--muted-foreground)' }}>乗車時刻</span>
              <input type="time" value={boardingTime} onChange={e => { setBoardingTime(e.target.value); setErrors(p => ({...p, boardingTime: ''})) }} className="text-sm font-medium outline-none" style={{ background: 'transparent', color: errors.boardingTime ? 'var(--accent)' : 'var(--foreground)' }} />
            </div>
          </div>
          {errors.station && <p className="text-xs mt-1" style={{ color: 'var(--accent)' }}>{errors.station}</p>}
          {errors.boardingTime && <p className="text-xs mt-1" style={{ color: 'var(--accent)' }}>{errors.boardingTime}</p>}

          {/* 余裕時間 */}
          <div className="rounded-xl overflow-hidden" style={{ border: '1.5px solid var(--border)', background: 'var(--card)' }}>
            <div className="flex items-center px-4 py-3 gap-2">
              <span>🛡️</span>
              <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>余裕時間</span>
              <span className="ml-auto text-sm font-bold" style={{ color: 'var(--accent)' }}>{margin}分</span>
            </div>
            <div style={{ height: 1, background: 'var(--border)' }} />
            <div className="px-4 py-3">
              {/* Preset buttons */}
              <div className="flex gap-2 mb-2">
                {PRESETS.map(m => (
                  <button
                    key={m}
                    onClick={() => handlePreset(m)}
                    className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95"
                    style={{
                      background: margin === m && !showCustom ? 'var(--primary)' : 'var(--muted)',
                      color: margin === m && !showCustom ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                      border: `1.5px solid ${margin === m && !showCustom ? 'var(--primary)' : 'transparent'}`,
                    }}
                  >
                    {m}分
                  </button>
                ))}
                <button
                  onClick={() => setShowCustom(v => !v)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95"
                  style={{
                    background: showCustom ? 'var(--primary)' : 'var(--muted)',
                    color: showCustom ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                    border: `1.5px solid ${showCustom ? 'var(--primary)' : 'transparent'}`,
                  }}
                >
                  任意
                </button>
              </div>
              {/* Custom input */}
              {showCustom && (
                <div className="flex gap-2 items-center mt-1">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={180}
                    placeholder="分を入力"
                    value={customMargin}
                    onChange={e => setCustomMargin(e.target.value)}
                    onBlur={handleCustomCommit}
                    onKeyDown={e => e.key === 'Enter' && handleCustomCommit()}
                    className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--muted)', border: '1.5px solid var(--border)', color: 'var(--foreground)' }}
                  />
                  <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>分</span>
                  <button
                    onClick={handleCustomCommit}
                    className="px-3 py-2 rounded-lg text-xs font-medium active:scale-95"
                    style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
                  >
                    確定
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Deadline summary */}
          <div className="rounded-xl px-4 py-3" style={{ background: 'var(--primary)' }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs mb-0.5" style={{ color: 'rgba(245,240,232,0.6)' }}>
                  乗車{margin}分前に駅着 → タイムリミット
                </p>
                <p className="text-lg font-bold" style={{ color: 'var(--primary-foreground)' }}>
                  {minutesToTime(Math.max(0, availableUntilMin))}までに駅へ
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs mb-0.5" style={{ color: 'rgba(245,240,232,0.6)' }}>空き時間</p>
                <p className="text-xl font-bold" style={{ color: freeMin > 0 ? 'var(--accent)' : '#f87171', fontFamily: 'Outfit' }}>
                  {freeMin > 0 ? formatMinutes(freeMin) : '—'}
                </p>
              </div>
            </div>
          </div>
        </section>

        <button onClick={handleSubmit} disabled={gpsLoading || locationResolving}
          className="w-full py-4 rounded-xl text-base font-bold tracking-wide active:scale-95 disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>
          {locationResolving ? '🔎 場所を確認中...' : gpsLoading ? '📍 現在地を取得中...' : '寄り道スポットを探す →'}
        </button>
      </div>
    </div>
  )
}

// ── Results Page ─────────────────────────────────────────────────────────────

type FetchState = 'idle' | 'loading' | 'done' | 'error'

function ResultsPage({ data, onBack, dark, onToggleDark }: {
  data: FormData; onBack: () => void; dark: boolean; onToggleDark: () => void
}) {
  const boardMin = timeToMinutes(data.boardingTime)
  const tripEndMin = timeToMinutes(data.tripEnd)
  const availableUntilMin = boardMin - data.margin
  const freeMin = Math.max(0, availableUntilMin - tripEndMin)

  // Walking budget: can do round trip + 10 min stay
  const maxWalkMin = Math.floor((freeMin - 10) / 2)
  // Approx radius: 80 m/min * maxWalkMin (capped at 1500m, min 400m)
  const radiusM = Math.min(1500, Math.max(400, maxWalkMin * 80))

  // InputPageで座標確定後にだけ遷移する。入力した場所を東京に置換しない。
  const baseLat = data.locationLat!
  const baseLng = data.locationLng!

  const [spots, setSpots] = useState<Place[]>([])
  const [foods, setFoods] = useState<Place[]>([])
  const [spotState, setSpotState] = useState<FetchState>('idle')
  const [foodState, setFoodState] = useState<FetchState>('idle')
  const [activeTab, setActiveTab] = useState<'spots' | 'food' | 'map' | 'favs'>('spots')
  const [favorites, setFavorites] = useState<Set<string>>(loadFavs)
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null)
  const [stationLat, setStationLat] = useState<number | null>(null)
  const [stationLng, setStationLng] = useState<number | null>(null)

  useEffect(() => {
    setSpotState('loading')
    fetchSpotPlaces(baseLat, baseLng, radiusM)
      .then(places => {
        // Filter to places reachable within available time (round trip + 10 min)
        setSpots(places.filter(p => p.walkMin * 2 + 10 <= freeMin).slice(0, 15))
        setSpotState('done')
      })
      .catch(() => setSpotState('error'))
  }, [baseLat, baseLng, radiusM])

  useEffect(() => {
    setFoodState('loading')
    fetchFoodPlaces(baseLat, baseLng, radiusM)
      .then(places => {
        setFoods(places.filter(p => p.walkMin <= maxWalkMin).slice(0, 15))
        setFoodState('done')
      })
      .catch(() => setFoodState('error'))
  }, [baseLat, baseLng, radiusM])

  // Geocode station name once
  useEffect(() => {
    if (!data.station) return
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(data.station)}&format=json&limit=1&accept-language=ja&countrycodes=jp`)
      .then(r => r.json())
      .then(results => {
        if (results[0]) { setStationLat(parseFloat(results[0].lat)); setStationLng(parseFloat(results[0].lon)) }
      })
      .catch(() => {})
  }, [data.station])

  const toggleFav = useCallback((id: string) => {
    setFavorites(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      saveFavs(next)
      return next
    })
  }, [])

  const allPlaces = [...spots, ...foods]
  const favPlaces = allPlaces.filter(p => favorites.has(p.id))
  const favSpots = favPlaces.filter(p => p.kind === 'spot')
  const favFoods = favPlaces.filter(p => p.kind === 'food')

  const tabs = [
    { key: 'spots' as const, label: '🗺️ スポット' },
    { key: 'food' as const, label: '🍽️ 食事' },
    { key: 'map' as const, label: '📍 地図' },
    { key: 'favs' as const, label: `❤️ 保存${favorites.size > 0 ? ` ${favorites.size}` : ''}` },
  ]

  const Spinner = () => (
    <div className="flex flex-col items-center py-14 gap-4">
      <div className="w-10 h-10 rounded-full border-4 border-t-transparent animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} />
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>OpenStreetMapから取得中...</p>
    </div>
  )

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--background)' }}>
      {/* Header */}
      <div style={{ background: 'var(--primary)' }} className="px-5 pt-12 pb-5">
        <div className="flex items-center justify-between mb-3">
          <button onClick={onBack} className="flex items-center gap-1 text-sm" style={{ color: 'rgba(245,240,232,0.7)' }}>← 戻る</button>
          <button onClick={onToggleDark} className="w-9 h-9 rounded-full flex items-center justify-center text-base active:scale-90" style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--primary-foreground)' }}>
            {dark ? '☀️' : '🌙'}
          </button>
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs mb-1" style={{ color: 'rgba(245,240,232,0.6)' }}>📍 {data.location}</p>
            <p className="text-lg font-bold leading-snug" style={{ color: 'var(--primary-foreground)' }}>
              {minutesToTime(tripEndMin)}〜{minutesToTime(availableUntilMin)} の寄り道
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs mb-0.5" style={{ color: 'rgba(245,240,232,0.6)' }}>空き時間</p>
            <p className="text-xl font-bold" style={{ color: 'var(--accent)', fontFamily: 'Outfit' }}>{formatMinutes(freeMin)}</p>
          </div>
        </div>
        <div className="flex gap-2 mt-3 flex-wrap">
          <div className="text-xs px-2.5 py-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(245,240,232,0.8)' }}>
            🚉 {data.station}発 {data.boardingTime}
          </div>
          <div className="text-xs px-2.5 py-1.5 rounded-full" style={{ background: 'rgba(200,92,46,0.3)', color: '#f5a880' }}>
            ⏱️ {minutesToTime(availableUntilMin)}までに駅へ（{data.margin}分前着）
          </div>
          <div className="text-xs px-2.5 py-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(245,240,232,0.7)' }}>
            🔍 半径{radiusM}m
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex px-3 pt-4 gap-1.5 pb-1 overflow-x-auto" style={{ background: 'var(--background)' }}>
        {tabs.map(({ key, label }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className="py-2 px-3 rounded-xl text-xs font-medium whitespace-nowrap"
            style={{
              background: activeTab === key ? 'var(--primary)' : 'var(--card)',
              color: activeTab === key ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
              border: `1.5px solid ${activeTab === key ? 'var(--primary)' : 'var(--border)'}`,
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Map */}
      {activeTab === 'map' && (
        <div className="flex-1 flex flex-col" style={{ minHeight: 0, position: 'relative' }}>
          {/* Map time limit banner */}
          <div className="flex items-center justify-between px-4 py-2.5 z-10 shrink-0" style={{ background: 'var(--primary)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'rgba(245,240,232,0.7)' }}>
              <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: '50%', background: '#c85c2e', display: 'inline-block' }} />指定場所</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: '50%', background: '#1a2e4a', display: 'inline-block' }} />スポット</span>
              <span className="flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 3, background: '#2d6a4f', display: 'inline-block' }} />食事</span>
            </div>
            <div className="text-right">
              <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(200,92,46,0.35)', color: '#f5a880' }}>
                ⏱️ {minutesToTime(availableUntilMin)}までに駅へ
              </span>
            </div>
          </div>

          {/* Map canvas */}
          <div className="flex-1 relative" style={{ minHeight: 320, height: 'calc(100vh - 280px)' }}>
            <MapView
              baseLat={baseLat} baseLng={baseLng}
              stationLat={stationLat} stationLng={stationLng} stationName={data.station}
              spots={spots} foods={foods}
              favorites={favorites}
              radiusM={radiusM}
              onSelectPlace={setSelectedPlace}
              selectedId={selectedPlace?.id ?? null}
            />
          </div>

          {/* Bottom place card (tap-to-show) */}
          <div
            className="shrink-0 transition-all duration-300"
            style={{
              maxHeight: selectedPlace ? 200 : 0,
              overflow: 'hidden',
              background: 'var(--card)',
              borderTop: '1.5px solid var(--border)',
              boxShadow: selectedPlace ? '0 -4px 20px rgba(0,0,0,0.12)' : 'none',
            }}
          >
            {selectedPlace && (
              <div className="px-4 py-4 relative">
                <div className="flex items-start gap-3">
                  <div className="text-2xl w-11 h-11 flex items-center justify-center rounded-xl shrink-0" style={{ background: 'var(--muted)' }}>
                    {selectedPlace.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-0.5">
                      <span className="font-semibold text-sm leading-snug" style={{ color: 'var(--foreground)' }}>{selectedPlace.name}</span>
                      <button
                        onClick={() => toggleFav(selectedPlace.id)}
                        className="text-lg shrink-0 active:scale-90 transition-all"
                      >
                        {favorites.has(selectedPlace.id) ? '❤️' : '🤍'}
                      </button>
                    </div>
                    {selectedPlace.subtitle && (
                      <p className="text-xs mb-1.5" style={{ color: 'var(--accent)' }}>{selectedPlace.subtitle}</p>
                    )}
                    <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: 'var(--muted-foreground)' }}>
                      <span>🚶 徒歩{selectedPlace.walkMin}分</span>
                      <span>🔄 往復{selectedPlace.walkMin * 2}分〜</span>
                      <span style={{ color: 'var(--foreground)', fontWeight: 500 }}>
                        {selectedPlace.kind === 'spot' ? '寄り道スポット' : '飲食店'}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedPlace(null)}
                  className="absolute top-3 right-3 text-xs px-2 py-1 rounded-lg"
                  style={{ color: 'var(--muted-foreground)', background: 'var(--muted)' }}
                >✕</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* List */}
      {activeTab !== 'map' && (
        <div className="flex-1 px-4 py-3 space-y-3 pb-10 overflow-y-auto">
          {activeTab === 'spots' && (
            spotState === 'loading' ? <Spinner /> :
            spotState === 'error' ? <Empty message="データの取得に失敗しました。通信状況を確認してください" /> :
            spots.length === 0 ? <Empty message="このエリアでは候補を取得できませんでした" /> :
            spots.map(p => <PlaceCard key={p.id} place={p} isFav={favorites.has(p.id)} onToggleFav={() => toggleFav(p.id)} dark={dark} />)
          )}
          {activeTab === 'food' && (
            foodState === 'loading' ? <Spinner /> :
            foodState === 'error' ? <Empty message="データの取得に失敗しました。通信状況を確認してください" /> :
            foods.length === 0 ? <Empty message="このエリアでは候補を取得できませんでした" /> :
            foods.map(p => <PlaceCard key={p.id} place={p} isFav={favorites.has(p.id)} onToggleFav={() => toggleFav(p.id)} dark={dark} />)
          )}
          {activeTab === 'favs' && (
            favorites.size === 0 ? (
              <div className="text-center py-14">
                <p className="text-4xl mb-3">🤍</p>
                <p className="text-sm font-medium mb-1" style={{ color: 'var(--foreground)' }}>お気に入りがまだありません</p>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>カードの 🤍 をタップして保存しましょう</p>
              </div>
            ) : (
              <>
                {favSpots.length > 0 && (
                  <>
                    <p className="text-xs font-semibold uppercase tracking-widest px-1" style={{ color: 'var(--muted-foreground)' }}>スポット</p>
                    {favSpots.map(p => <PlaceCard key={p.id} place={p} isFav={true} onToggleFav={() => toggleFav(p.id)} dark={dark} />)}
                  </>
                )}
                {favFoods.length > 0 && (
                  <>
                    <p className="text-xs font-semibold uppercase tracking-widest px-1 mt-2" style={{ color: 'var(--muted-foreground)' }}>食事・カフェ</p>
                    {favFoods.map(p => <PlaceCard key={p.id} place={p} isFav={true} onToggleFav={() => toggleFav(p.id)} dark={dark} />)}
                  </>
                )}
              </>
            )
          )}
        </div>
      )}

      {activeTab !== 'map' && (
        <div className="px-4 pb-8 pt-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--background)' }}>
          <p className="text-center text-xs mb-3" style={{ color: 'var(--muted-foreground)' }}>
            🕐 {minutesToTime(availableUntilMin)} までに {data.station} へ出発
          </p>
          <button onClick={onBack} className="w-full py-3 rounded-xl text-sm font-medium active:scale-95" style={{ background: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1.5px solid var(--border)' }}>
            条件を変更する
          </button>
        </div>
      )}
    </div>
  )
}

// ── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>('input')
  const [formData, setFormData] = useState<FormData | null>(null)
  const [dark, setDark] = useState(loadDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem(DARK_KEY, String(dark))
  }, [dark])

  const toggleDark = useCallback(() => setDark(d => !d), [])

  return (
    <div style={{ maxWidth: 430, margin: '0 auto', minHeight: '100vh' }}>
      {view === 'input' && (
        <InputPage
          onSubmit={d => { setFormData(d); setView('results'); window.scrollTo(0, 0) }}
          dark={dark} onToggleDark={toggleDark}
        />
      )}
      {view === 'results' && formData && (
        <ResultsPage data={formData} onBack={() => setView('input')} dark={dark} onToggleDark={toggleDark} />
      )}
    </div>
  )
}
