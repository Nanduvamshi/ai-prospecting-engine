"use client";

import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import React from "react";
import { cn } from "@/lib/utils";

interface LoaderProps {
  variant?: "spinner" | "progress" | "pulse" | "dots";
  size?: "xs" | "sm" | "base" | "md" | "lg";
  message?: string;
  progress?: number;
  className?: string;
}

const sizeMap = {
  xs: { container: "w-4 h-4", text: "text-xs" },
  sm: { container: "w-6 h-6", text: "text-xs" },
  base: { container: "w-8 h-8", text: "text-sm" },
  md: { container: "w-10 h-10", text: "text-sm" },
  lg: { container: "w-16 h-16", text: "text-base" },
};

/**
 * Unified Loader component with orange theme
 * Supports multiple variants: spinner, progress, pulse, dots
 *
 * @example
 * // Basic spinner
 * <Loader />
 *
 * // With message
 * <Loader message="Loading..." size="lg" />
 *
 * // Progress variant
 * <Loader variant="progress" progress={65} message="Uploading..." />
 *
 * // Pulse variant for subtle loading
 * <Loader variant="pulse" />
 *
 * // Dots variant for inline loading
 * <Loader variant="dots" size="sm" />
 */
export function Loader({
  variant = "spinner",
  size = "md",
  message,
  progress = 0,
  className = "",
}: LoaderProps) {
  const { container, text } = sizeMap[size];

  if (variant === "spinner") {
    return (
      <div className={`flex flex-col items-center gap-3 ${className}`}>
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          className={`${container} relative`}
        >
          <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-primary">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="31.4 31.4"
              opacity="0.2"
            />
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="31.4 31.4"
              strokeDashoffset="23.55"
            />
          </svg>
        </motion.div>
        {message && <p className={`${text} text-muted-foreground font-medium`}>{message}</p>}
      </div>
    );
  }

  if (variant === "progress") {
    return (
      <div className={`flex flex-col items-center gap-4 ${className}`}>
        <div className="w-48 h-2 rounded-full overflow-hidden bg-primary/10">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.3 }}
            className="h-full rounded-full bg-linear-to-r from-primary to-orange-400"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className={`${text} font-semibold text-primary`}>{progress}%</span>
          {message && <span className={`${text} text-muted-foreground`}>{message}</span>}
        </div>
      </div>
    );
  }

  if (variant === "pulse") {
    return (
      <motion.div
        animate={{ scale: [0.95, 1.05, 0.95], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className={`${container} rounded-full bg-linear-to-br from-primary/20 to-orange-400/20 ${className}`}
      />
    );
  }

  if (variant === "dots") {
    return (
      <div className={`flex items-center gap-1 ${className}`}>
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
            transition={{
              duration: 0.8,
              repeat: Infinity,
              delay: i * 0.1,
            }}
            className={`w-1.5 h-1.5 rounded-full bg-primary`}
          />
        ))}
        {message && <span className={`${text} text-muted-foreground ml-2`}>{message}</span>}
      </div>
    );
  }

  return null;
}

/**
 * Overlay loader for full-screen or container loading states
 *
 * @example
 * <LoaderOverlay isLoading={isLoading} message="Loading data..." />
 */
export function LoaderOverlay({
  isLoading,
  message = "Loading...",
  fullScreen = false,
}: {
  isLoading: boolean;
  message?: string;
  fullScreen?: boolean;
}) {
  if (!isLoading) return null;

  const containerClass = fullScreen
    ? "fixed inset-0 z-50"
    : "absolute inset-0 z-30";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`${containerClass} flex items-center justify-center bg-background/80 backdrop-blur-sm`}
    >
      <Loader variant="spinner" size="lg" message={message} />
    </motion.div>
  );
}

/**
 * Inline loader for buttons and small spaces
 *
 * @example
 * <Button variant="ghost">
 *   {isLoading ? <InlineLoader /> : "Click me"}
 * </Button>
 */
export function InlineLoader({
  size = "sm",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  const sizeValue = size === "sm" ? "w-4 h-4" : "w-5 h-5";
  return (
    <motion.div
      animate={{ rotate: 360 }}
      transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
      className={cn(sizeValue, "text-primary", className)}
    >
      <svg viewBox="0 0 24 24" fill="none" className="w-full h-full">
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="31.4 31.4"
          opacity="0.2"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="31.4 31.4"
          strokeDashoffset="23.55"
        />
      </svg>
    </motion.div>
  );
}