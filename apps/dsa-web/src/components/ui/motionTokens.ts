import { useEffect } from 'react';
import {
  useMotionValue,
  useReducedMotion,
  useSpring,
  type MotionValue,
  type Transition,
  type Variants,
} from 'motion/react';

/**
 * Shared motion language for the "Obsidian Terminal" look:
 * buttery springs, short staggered entrances, and tabular-numeral count-ups.
 * Constants and hooks live apart from the components in `motion.tsx` so fast
 * refresh keeps working.
 */

export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 240, damping: 30, mass: 0.9 };
export const SPRING_ENTER: Transition = { type: 'spring', stiffness: 320, damping: 34, mass: 0.8 };
export const SPRING_NUMBER: Transition = { type: 'spring', stiffness: 170, damping: 26, mass: 0.9 };
export const SPRING_GAUGE: Transition = { type: 'spring', stiffness: 90, damping: 20, mass: 1 };

/**
 * Entrance variant animates transform only: content is never rendered at
 * opacity 0, so assistive tech, print, and RTL visibility assertions always
 * see the settled layout while the spring still delivers the motion.
 */
export const fadeUp: Variants = {
  hidden: { y: 18 },
  show: {
    y: 0,
    transition: SPRING_ENTER,
  },
};

export const fadeIn: Variants = {
  hidden: { y: 8 },
  show: {
    y: 0,
    transition: { duration: 0.4, ease: 'easeOut' },
  },
};

/** Stagger preset: 40-60ms per child keeps dense dashboards readable. */
export const staggerContainer = (staggerChildren = 0.05, delayChildren = 0.02): Variants => ({
  hidden: {},
  show: {
    transition: { staggerChildren, delayChildren },
  },
});

/** Reduced-motion analogue of any spring: effectively instant. */
export const REDUCED_MOTION_SPRING: Transition = { stiffness: 1200, damping: 220 };

/** Convenience hook for surfaces that animate their own numbers via springs. */
export const useSpringNumber = (value: number, transition: Transition = SPRING_GAUGE): MotionValue<number> => {
  const prefersReducedMotion = useReducedMotion();
  const rawValue = useMotionValue(value);
  const springValue = useSpring(rawValue, prefersReducedMotion ? REDUCED_MOTION_SPRING : transition);

  useEffect(() => {
    rawValue.set(value);
  }, [rawValue, value]);

  return springValue;
};
