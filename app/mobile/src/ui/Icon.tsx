// Stroke icons (viewBox 24, 1.75 px), drawn here: few and consistent, without an extra library.
import Svg, { Circle, Path, Rect } from 'react-native-svg'

export type IconName =
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'x'
  | 'stop'
  | 'sliders'
  | 'search'
  | 'lock'
  | 'laptop'
  | 'folder'
  | 'camera'
  | 'bell'
  | 'plus'
  | 'edit'
  | 'send'
  | 'shield'
  | 'alert'
  | 'refresh'
  | 'gauge'
  | 'mic'
  | 'image'
  | 'clipboard'
  | 'file'
  | 'slash'
  | 'user-off'
  | 'sparkle'
  | 'live'

interface Props {
  name: IconName
  size?: number
  color: string
  strokeWidth?: number
}

export function Icon({ name, size = 20, color, strokeWidth = 1.75 }: Props) {
  const p = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  let body
  switch (name) {
    case 'chevron-right':
      body = <Path d="M9 6l6 6-6 6" {...p} />
      break
    case 'chevron-left':
      body = <Path d="M15 6l-6 6 6 6" {...p} />
      break
    case 'chevron-down':
      body = <Path d="M6 9l6 6 6-6" {...p} />
      break
    case 'arrow-up':
      body = <Path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" {...p} />
      break
    case 'arrow-down':
      body = <Path d="M12 5v14M5.5 12.5L12 19l6.5-6.5" {...p} />
      break
    case 'check':
      body = <Path d="M5 12.5l4.5 4.5L19 7.5" {...p} />
      break
    case 'x':
      body = <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...p} />
      break
    case 'stop':
      body = <Rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill={color} />
      break
    case 'sliders':
      body = (
        <>
          <Path d="M4 7h9M17 7h3M4 17h3M11 17h9" {...p} />
          <Circle cx="15" cy="7" r="2" {...p} />
          <Circle cx="9" cy="17" r="2" {...p} />
        </>
      )
      break
    case 'search':
      body = (
        <>
          <Circle cx="11" cy="11" r="6" {...p} />
          <Path d="M20 20l-4.2-4.2" {...p} />
        </>
      )
      break
    case 'lock':
      body = (
        <>
          <Rect x="5" y="10.5" width="14" height="9.5" rx="2.5" {...p} />
          <Path d="M8 10.5V8a4 4 0 018 0v2.5" {...p} />
        </>
      )
      break
    case 'laptop':
      body = (
        <>
          <Rect x="5" y="5.5" width="14" height="10" rx="2" {...p} />
          <Path d="M3 19h18" {...p} />
        </>
      )
      break
    case 'folder':
      body = <Path d="M3.5 7.5a2 2 0 012-2h3.6l2 2.2h7.4a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2V7.5z" {...p} />
      break
    case 'camera':
      body = (
        <>
          <Path d="M4 8.5a2 2 0 012-2h1.6l1.2-1.8h6.4l1.2 1.8H18a2 2 0 012 2V17a2 2 0 01-2 2H6a2 2 0 01-2-2V8.5z" {...p} />
          <Circle cx="12" cy="12.7" r="3.2" {...p} />
        </>
      )
      break
    case 'bell':
      body = <Path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5H5l1.5-1.5zM10 20.5a2 2 0 004 0" {...p} />
      break
    case 'plus':
      body = <Path d="M12 5v14M5 12h14" {...p} />
      break
    case 'edit':
      body = <Path d="M5 19l1-4L16.5 4.5a1.8 1.8 0 012.5 2.5L8.5 17.5 5 19z" {...p} />
      break
    case 'send':
      body = <Path d="M4 12l16-8-6 16-2.5-6.5L4 12z" {...p} />
      break
    case 'shield':
      body = <Path d="M12 4l7 2.5v5.2c0 4-2.7 6.7-7 8.3-4.3-1.6-7-4.3-7-8.3V6.5L12 4z" {...p} />
      break
    // Stroked warning triangle: not the filled triangle of the "waiting for you" state.
    case 'alert':
      body = (
        <>
          <Path d="M12 4.2l8.4 14.6H3.6L12 4.2z" {...p} />
          <Path d="M12 10v4" {...p} />
          <Circle cx="12" cy="16.6" r="0.6" fill={color} stroke={color} strokeWidth={0.8} />
        </>
      )
      break
    case 'refresh':
      body = <Path d="M19 12a7 7 0 11-2.1-5M19 4.5V8h-3.5" {...p} />
      break
    case 'mic':
      body = (
        <>
          <Rect x="9" y="4" width="6" height="10.5" rx="3" {...p} />
          <Path d="M6 11.5a6 6 0 0012 0M12 17.5V20.5" {...p} />
        </>
      )
      break
    case 'image':
      body = (
        <>
          <Rect x="4" y="5" width="16" height="14" rx="2.5" {...p} />
          <Circle cx="9" cy="10" r="1.5" {...p} />
          <Path d="M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4" {...p} />
        </>
      )
      break
    case 'clipboard':
      body = (
        <>
          <Rect x="6" y="5.5" width="12" height="14.5" rx="2.5" {...p} />
          <Path d="M9.5 5.5V5a1 1 0 011-1h3a1 1 0 011 1v.5M9.5 11h5M9.5 14.5h5" {...p} />
        </>
      )
      break
    case 'file':
      body = <Path d="M7 4h6.5L18 8.5V19a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 016 19V5.5A1.5 1.5 0 017 4zM13.5 4v4.5H18" {...p} />
      break
    case 'slash':
      body = <Path d="M15.5 4.5l-7 15" {...p} />
      break
    case 'user-off':
      body = (
        <>
          <Circle cx="12" cy="9" r="3.2" {...p} />
          <Path d="M5.5 19.5c.6-3.3 3.2-5 6.5-5s5.9 1.7 6.5 5" {...p} />
          <Path d="M4.5 4.5l15 15" {...p} />
        </>
      )
      break
    case 'sparkle':
      body = <Path d="M12 4.5l1.9 5.6 5.6 1.9-5.6 1.9L12 19.5l-1.9-5.6-5.6-1.9 5.6-1.9L12 4.5z" {...p} />
      break
    case 'live':
      // Waves coming out of a point: "live".
      body = (
        <>
          <Circle cx="12" cy="12" r="2.2" {...p} />
          <Path d="M7.6 7.6a6.2 6.2 0 000 8.8M16.4 7.6a6.2 6.2 0 010 8.8" {...p} />
        </>
      )
      break
    case 'gauge':
      body = (
        <>
          <Path d="M4.5 16.5a7.5 7.5 0 1115 0" {...p} />
          <Path d="M12 16.5l3.2-4.4" {...p} />
        </>
      )
      break
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {body}
    </Svg>
  )
}
