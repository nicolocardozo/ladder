// Icone a tratto (viewBox 24, 1.75 px), disegnate qui: poche e coerenti, senza una libreria in più.
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
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {body}
    </Svg>
  )
}
