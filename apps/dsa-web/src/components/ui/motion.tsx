import type React from 'react';
import { useEffect } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type Transition } from 'motion/react';
import { cn } from '../../utils/cn';
import { REDUCED_MOTION_SPRING, SPRING_NUMBER, fadeUp, staggerContainer } from './motionTokens';

/**
 * Motion primitives for the "Obsidian Terminal" look: staggered fade-up
 * entrances and tabular-numeral spring count-ups. Every helper honours
 * `prefers-reduced-motion` by falling back to the final state.
 */

export type StaggerGroupProps = {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
  delayChildren?: number;
  /** Animate only once when scrolled into view (default: on mount). */
  whenInView?: boolean;
  amount?: number;
};

export const StaggerGroup: React.FC<StaggerGroupProps> = ({
  children,
  className,
  stagger = 0.05,
  delayChildren = 0.02,
  whenInView = false,
  amount = 0.15,
}) => {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial="hidden"
      {...(whenInView ? { whileInView: 'show', viewport: { once: true, amount } } : { animate: 'show' })}
      variants={staggerContainer(stagger, delayChildren)}
    >
      {children}
    </motion.div>
  );
};

export type StaggerItemProps = {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

export const StaggerItem: React.FC<StaggerItemProps> = ({ children, className, style }) => {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }

  return (
    <motion.div className={className} style={style} variants={fadeUp}>
      {children}
    </motion.div>
  );
};

type AnimatedNumberProps = {
  value: number;
  /** Formats the animated value; defaults to the integer string. */
  format?: (value: number) => string;
  className?: string;
  style?: React.CSSProperties;
  transition?: Transition;
  'aria-label'?: string;
  'data-testid'?: string;
};

/**
 * Spring count-up for prices and scores. Renders tabular numerals so digits
 * never jitter while the spring settles. The first paint already shows the
 * target value (only *changes* animate), so tests and SSR snapshots stay stable.
 */
export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  format = (latest: number) => String(Math.round(latest)),
  className,
  style,
  transition = SPRING_NUMBER,
  ...rest
}) => {
  const prefersReducedMotion = useReducedMotion();
  const rawValue = useMotionValue(value);
  const springValue = useSpring(rawValue, prefersReducedMotion ? REDUCED_MOTION_SPRING : transition);
  const text = useTransform(springValue, (latest: number) => format(latest));

  useEffect(() => {
    rawValue.set(value);
  }, [rawValue, value]);

  if (prefersReducedMotion) {
    return (
      <span className={cn('num', className)} style={style} {...rest}>
        {format(value)}
      </span>
    );
  }

  return (
    <motion.span className={cn('num', className)} style={style} {...rest}>
      {text}
    </motion.span>
  );
};
